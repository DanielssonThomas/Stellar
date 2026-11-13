"""Retained producer bookkeeping; Hermes alone owns notification admission/execution."""
from __future__ import annotations

from contextlib import contextmanager
import json
import sqlite3

from .core import Unavailable
from .observation_store import FRESHNESS, INTERVAL, ObservationStore

MAX_BINDINGS = 100
MAX_ATTEMPTS = 1000


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False)


class NotificationStore(ObservationStore):
    @contextmanager
    def transaction(self):
        with super().transaction() as db:
            db.execute('''CREATE TABLE IF NOT EXISTS notification_bindings (
                incarnation TEXT NOT NULL, revision INTEGER NOT NULL, issue INTEGER NOT NULL,
                binding TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('active','revoke_pending','revoked')),
                outcome TEXT, next_check REAL NOT NULL, PRIMARY KEY(incarnation,revision))''')
            db.execute('''CREATE TABLE IF NOT EXISTS notification_attempts (
                event_id TEXT PRIMARY KEY, incarnation TEXT NOT NULL, revision INTEGER NOT NULL,
                content TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('unknown','known')),
                outcome TEXT, observed REAL NOT NULL, next_check REAL NOT NULL)''')
            yield db

    def current(self, issue):
        with self.transaction() as db:
            row = db.execute('SELECT * FROM tracking WHERE issue=? AND enabled=1', (issue,)).fetchone()
            return dict(row) if row else None

    def save_binding(self, track, binding, now):
        with self.transaction() as db:
            old = db.execute('SELECT binding FROM notification_bindings WHERE incarnation=? AND revision=?',
                             (track['incarnation'], track['revision'])).fetchone()
            if old:
                if json.loads(old['binding']) != binding:
                    raise Unavailable('This tracking revision already has another notification binding.')
                return
            if db.execute('SELECT count(*) FROM notification_bindings').fetchone()[0] >= MAX_BINDINGS:
                raise Unavailable('Retained notification bindings are full; no evidence was discarded.')
            active = db.execute('SELECT 1 FROM tracking WHERE incarnation=? AND revision=? '
                                'AND enabled=1 AND expires>?', (track['incarnation'], track['revision'], now)).fetchone()
            db.execute('INSERT INTO notification_bindings VALUES(?,?,?,?,?,?,?)',
                       (track['incarnation'], track['revision'], track['issue'], encoded(binding),
                        'active' if active else 'revoke_pending', None, now))

    def sync(self, now):
        with self.transaction() as db:
            self.prune(db, now)
            db.execute("UPDATE notification_bindings SET phase='revoke_pending' WHERE phase='active' AND NOT EXISTS "
                       '(SELECT 1 FROM tracking t WHERE t.incarnation=notification_bindings.incarnation '
                       'AND t.revision=notification_bindings.revision AND t.enabled=1 AND t.expires>?)', (now,))

    def pending_revokes(self, now, *, issue=None, session_id=None):
        self.sync(now)
        with self.transaction() as db:
            rows = db.execute("SELECT * FROM notification_bindings WHERE phase='revoke_pending' AND next_check<=? "
                              'AND (? IS NULL OR issue=?) AND (? IS NULL OR '
                              "json_extract(binding,'$.owner_session_id')=?) "
                              'ORDER BY next_check,incarnation,revision LIMIT 4',
                              (now, issue, issue, session_id, session_id)).fetchall()
            for row in rows:
                db.execute('UPDATE notification_bindings SET next_check=? WHERE incarnation=? AND revision=?',
                           (now + INTERVAL, row['incarnation'], row['revision']))
            return [dict(row) for row in rows]

    def revoked(self, saved, outcome):
        with self.transaction() as db:
            db.execute("UPDATE notification_bindings SET phase='revoked',outcome=? "
                       "WHERE incarnation=? AND revision=? AND phase='revoke_pending'",
                       (encoded(outcome), saved['incarnation'], saved['revision']))

    def lookup(self, event_id):
        # Authorization needs this lookup; never create/mutate storage for a refused RPC.
        if not self.path.exists():
            return None
        db = sqlite3.connect(self.path.resolve().as_uri() + '?mode=ro', uri=True, timeout=2)
        db.row_factory = sqlite3.Row
        try:
            if not db.execute("SELECT 1 FROM sqlite_master WHERE name='notification_attempts'").fetchone():
                return None
            row = db.execute('SELECT a.*,b.binding,b.phase AS binding_phase,b.issue '
                             'FROM notification_attempts a JOIN notification_bindings b '
                             'ON a.incarnation=b.incarnation AND a.revision=b.revision WHERE a.event_id=?',
                             (event_id,)).fetchone()
            return dict(row) if row else None
        finally:
            db.close()

    @staticmethod
    def _eligible(db, event_id, now):
        return db.execute('SELECT t.*,w.receipt,w.issue,w.expires,b.binding FROM transitions t '
            'JOIN tracking w ON w.incarnation=t.incarnation AND w.revision=t.revision '
            'JOIN notification_bindings b ON b.incarnation=t.incarnation AND b.revision=t.revision '
            "WHERE t.identity=? AND w.enabled=1 AND w.health='current' AND b.phase='active' "
            'AND w.expires>? AND t.observed BETWEEN ? AND ? AND w.observed BETWEEN ? AND ?',
            (event_id, now, now-FRESHNESS, now, now-FRESHNESS, now)).fetchone()

    def eligible(self, event_id, now):
        self.sync(now)
        with self.transaction() as db:
            return self._eligible(db, event_id, now) is not None

    def reserve_event(self, event_id, now):
        with self.transaction() as db:
            if db.execute('SELECT 1 FROM notification_attempts WHERE event_id=?', (event_id,)).fetchone():
                return False
            row = self._eligible(db, event_id, now)
            if row is None:
                return False
            if db.execute('SELECT count(*) FROM notification_attempts').fetchone()[0] >= MAX_ATTEMPTS:
                raise Unavailable('Retained notification attempts are full; UNKNOWN evidence was preserved.')
            receipt = json.loads(row['receipt'])
            content = encoded({'schemaVersion': 1, 'milestone': row['kind'], 'fact': json.loads(row['fact']),
                'issue': row['issue'], 'worker': receipt, 'observedAt': row['observed'],
                'validUntil': min(row['expires'], row['observed'] + FRESHNESS),
                'instruction': 'Observation evidence only. Verify fresh Herdr/GitHub facts before reporting; '
                               'process exit does not establish issue completion or grant action authority.'})
            if len(content.encode('utf-8')) > 16384:
                raise Unavailable('The notification evidence exceeds the supported envelope bound.')
            # Only this INSERT's caller may first-send. A crash here leaves UNKNOWN, never takeover.
            db.execute('INSERT INTO notification_attempts VALUES(?,?,?,?,?,?,?,?)',
                       (event_id, row['incarnation'], row['revision'], content, 'unknown', None,
                        row['observed'], now + INTERVAL))
            return True

    def candidates(self, now, *, session_id=None):
        fresh = self.status(now)['transitions']
        with self.transaction() as db:
            rows = db.execute('SELECT a.event_id,a.next_check FROM notification_attempts a '
                              'JOIN notification_bindings b ON a.incarnation=b.incarnation AND a.revision=b.revision '
                              "WHERE a.next_check<=? AND (a.phase='unknown' OR json_extract(a.outcome,'$.receipt.status')!='terminal') "
                              "AND (? IS NULL OR json_extract(b.binding,'$.owner_session_id')=?) "
                              'ORDER BY a.next_check,a.event_id LIMIT 4', (now, session_id, session_id)).fetchall()
            due = {row['event_id']: row['next_check'] for row in rows}
            for event in fresh:
                row = self._eligible(db, event['identity'], now)
                if row is None or (session_id is not None and json.loads(row['binding'])['owner_session_id'] != session_id):
                    continue
                if not db.execute('SELECT 1 FROM notification_attempts WHERE event_id=?', (event['identity'],)).fetchone():
                    due[event['identity']] = event['observed']
            chosen = sorted(due, key=lambda key: (due[key], key))[:4]
            for event_id in chosen:
                db.execute('UPDATE notification_attempts SET next_check=? WHERE event_id=?', (now+INTERVAL, event_id))
            return chosen

    def active_scope(self, session_id):
        if not self.path.exists():
            return None
        db = sqlite3.connect(self.path.resolve().as_uri() + '?mode=ro', uri=True, timeout=2)
        try:
            if not db.execute("SELECT 1 FROM sqlite_master WHERE name='notification_bindings'").fetchone():
                return None
            bound = db.execute("SELECT 1 FROM notification_bindings WHERE json_extract(binding,'$.owner_session_id')=?",
                               (session_id,)).fetchone()
            if bound is None:
                return None
            return [(row[0], row[1]) for row in db.execute('SELECT w.incarnation,w.revision FROM tracking w '
                'JOIN notification_bindings b ON w.incarnation=b.incarnation AND w.revision=b.revision '
                "WHERE w.enabled=1 AND b.phase='active' AND json_extract(b.binding,'$.owner_session_id')=?",
                (session_id,))]
        finally:
            db.close()

    def remember(self, event_id, response):
        summary = {key: response[key] for key in ('status', 'receipt', 'descriptor')}
        with self.transaction() as db:
            old = db.execute('SELECT outcome FROM notification_attempts WHERE event_id=?', (event_id,)).fetchone()
            previous = json.loads(old['outcome']) if old and old['outcome'] else None
            if previous:
                before, after = previous['receipt'], summary['receipt']
                if any(before[key] != after[key] for key in ('admission_id', 'ref', 'sequence')):
                    raise Unavailable('Canonical admission identity changed; retained evidence was not replaced.')
                ranks = {'queued': 0, 'started': 1, 'unknown': 2, 'terminal': 3}
                if ranks[before['status']] > ranks[after['status']]:
                    return
                if before.get('execution_generation') is not None and any(
                        before[key] != after[key] for key in ('execution_generation', 'authority_epoch')):
                    raise Unavailable('Canonical execution identity changed; retained evidence was not replaced.')
                if before['status'] == 'terminal' and before != after:
                    raise Unavailable('Canonical terminal receipt changed; retained evidence was not replaced.')
            db.execute("UPDATE notification_attempts SET phase='known',outcome=? WHERE event_id=?",
                       (encoded(summary), event_id))

    def disable_binding(self, saved):
        with self.transaction() as db:
            db.execute('UPDATE consent SET revision=revision+1 WHERE id=1')
            db.execute("UPDATE tracking SET enabled=0,revision=revision+1,lease=NULL,health='opted_out' "
                       'WHERE incarnation=? AND revision=? AND enabled=1', (saved['incarnation'], saved['revision']))
            db.execute('DELETE FROM transitions WHERE incarnation=? AND revision=?',
                       (saved['incarnation'], saved['revision']))
            db.execute("UPDATE notification_bindings SET phase='revoke_pending' WHERE incarnation=? "
                       "AND revision=? AND phase='active'", (saved['incarnation'], saved['revision']))

    def summary(self, now):
        self.sync(now)
        with self.transaction() as db:
            return {table: dict(db.execute('SELECT phase,count(*) FROM ' + table + ' GROUP BY phase'))
                    for table in ('notification_bindings', 'notification_attempts')}
