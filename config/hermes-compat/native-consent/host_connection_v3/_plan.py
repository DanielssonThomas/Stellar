"""Private, unauthenticated DATA plan used only in isolated composition fixtures.

No constructor here establishes an actual native lease, gesture or ticket authority.
The public attach factory remains unavailable. Same-user code tampering is not fenced
by Python privacy. No endpoints, database opening, schema migration or OS calls.
"""
import json
from threading import Lock

import journal_v3 as journal
from journal_v3.errors import require
from journal_v3.validation import digest, hexid, integer, pack_context, pack_prepared
from ._transaction import bind_on, cancel_binding_on


class _ConnectionPlan:
    def __init__(self, db, original, context, prepared, *, wall_ms, monotonic_ms):
        self._db, self._original = db, original
        self._wall, self._mono = wall_ms, monotonic_ms
        wall, mono = integer(wall_ms()), integer(monotonic_ms())
        self._created = wall
        self._context_json = pack_context(context)[0]
        self._scope_json = pack_prepared(prepared, wall)[0]
        self._context = json.loads(self._context_json)
        self._scope = json.loads(self._scope_json)
        self._deadline = integer(mono + self._scope['challengeExpiresAt'] - wall)
        self._last = (wall, mono)
        self._ticket_deadline = None
        self._ticket = None
        self._ticket_hash = None
        self._phase = 'new'
        self._busy = None
        self._generation = 0
        self._denied = False
        self._uncertain = False
        self._lock = Lock()

    def _seal(self):
        self._uncertain = True
        self._ticket = None

    def _check_locked(self, original, context, prepared):
        require(not self._denied and not self._uncertain, 'consent_uncertain')
        require(original is self._original, 'connection_changed')
        require(pack_context(context)[0] == self._context_json, 'context_changed')
        require(pack_prepared(prepared, self._created)[0] == self._scope_json, 'context_changed')
        wall, mono = integer(self._wall()), integer(self._mono())
        require(wall >= self._last[0] and mono >= self._last[1], 'clock_changed')
        self._last = (wall, mono)
        require(wall < self._scope['challengeExpiresAt'] and mono < self._deadline, 'consent_expired')
        if self._ticket_deadline is not None:
            deadline_wall, deadline_mono = self._ticket_deadline
            require(wall < deadline_wall and mono < deadline_mono, 'consent_expired')
        return wall, mono

    def _execute(self, expected, next_phase, original, context, prepared, callback, prepare=None):
        with self._lock:
            try:
                require(self._busy is None and self._phase == expected, 'consent_uncertain')
                wall, mono = self._check_locked(original, context, prepared)
                if prepare is not None:
                    prepare(wall, mono)
                self._generation += 1
                generation = self._generation
                self._busy = generation
            except BaseException:
                self._seal()
                raise

        def fresh_now():
            with self._lock:
                require(self._busy == generation, 'consent_uncertain')
                return self._check_locked(original, context, prepared)[0]

        def write(conn):
            fresh_now()
            return callback(conn, fresh_now)

        try:
            result = journal.write_once(self._db, write)
            with self._lock:
                require(self._busy == generation, 'consent_uncertain')
                self._check_locked(original, context, prepared)
                self._phase = next_phase
                self._busy = None
                return result
        except BaseException:
            with self._lock:
                self._seal()
                self._busy = None
            raise

    def reserve(self, original, context, prepared):
        self._execute('new', 'pending', original, context, prepared,
            lambda conn, now: journal.reserve_on(conn, self._context, self._scope, now()))
        return json.loads(self._scope_json)

    def begin(self, original, context, prepared):
        return self._execute('pending', 'confirming', original, context, prepared,
            lambda conn, now: journal.begin_on(conn, self._scope['challengeId'], self._context, now()))

    def reserve_issue(self, original, context, prepared, intent_id):
        return self._execute('confirming', 'issuing', original, context, prepared,
            lambda conn, now: journal.reserve_issue_on(conn, self._scope['challengeId'],
                self._context, intent_id, now()))

    def record_ticket(self, original, context, prepared, intent_id, ticket_data, deadline):
        def pin(wall, mono):
            hexid(ticket_data)
            integer(deadline, wall + 1, min(self._scope['expiresAt'], wall + 60000))
            self._ticket_deadline = (deadline, min(self._deadline, integer(mono + deadline - wall)))
            self._ticket, self._ticket_hash = ticket_data, digest(ticket_data)
        return self._execute('issuing', 'issued', original, context, prepared,
            lambda conn, now: journal.record_ticket_on(conn, self._scope['challengeId'],
                self._context, intent_id, self._ticket_hash, deadline, now()), pin)

    def release(self, original, context, prepared):
        released = None
        def reserve(_wall, _mono):
            nonlocal released
            require(self._ticket is not None, 'consent_uncertain')
            released, self._ticket = self._ticket, None
        self._execute('issued', 'released', original, context, prepared,
            lambda conn, now: journal.reserve_release_on(conn, self._scope['challengeId'],
                self._context, now()), reserve)
        return released  # DATA only, no transport write or authentication claim.

    def bind(self, original, context, prepared, ticket_data):
        def match(_wall, _mono):
            require(digest(hexid(ticket_data)) == self._ticket_hash, 'consent_uncertain')
        return self._execute('released', 'bound', original, context, prepared,
            lambda conn, now: bind_on(conn, self._context, self._scope, self._ticket_hash, now), match)

    def cancel(self, original):
        with self._lock:
            require(original is self._original, 'connection_changed')
            self._denied = True
            self._generation += 1
            self._ticket = None
        # Cancellation does not clear _uncertain, manufacture a receipt or stop effects.
        try:
            return journal.write_once(self._db, lambda conn: cancel_binding_on(conn, self._context, self._scope))
        except BaseException:
            with self._lock:
                self._seal()
            raise
