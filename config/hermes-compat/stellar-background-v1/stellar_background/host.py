"""Explicit host composition, never imported/registered by the observation plugin.

The native gesture verifier and current producer/policy gate are mandatory host ports.
They cannot be replaced by a JSON boolean, model text or a caller-supplied Origin.
No capability is advertised by this inactive candidate.
"""
from __future__ import annotations

import hashlib
import secrets
import threading
import re
from dataclasses import dataclass

from .contract import ContractError, Origin, canonical, closed, event_digest, integer, text
from .ledger import Ledger


class Host:
    def __init__(self, authority, *, runtime_root, verify_native, verify_gesture, policy_gate, clock,
                 bootstrap_root=None, facts_path=None):
        if not all(callable(port) for port in (verify_native, verify_gesture, policy_gate)):
            raise ContractError('host_wiring_unavailable')
        from .provenance import verify_candidate
        verify_candidate(runtime_root, bootstrap_root=bootstrap_root, facts_path=facts_path)
        with authority.db._read_ctx() as conn:
            row = conn.execute('SELECT package_digest FROM stellar_bg_installation_v1 WHERE singleton=1').fetchone()
        if row is not None and row[0]:
            from pathlib import Path
            from .package import package_digest
            import sys
            directory = Path(runtime_root).resolve() / 'stellar_background_compat'
            if row[0] != package_digest() or any(
                not Path(m.__file__).resolve().is_relative_to(directory)
                for name, m in list(sys.modules.items()) if name == 'stellar_background' or name.startswith('stellar_background.')):
                raise ContractError('package_module_mismatch')
            from .package import Package
            Package(Path(runtime_root).resolve().parent).verify(authority.db)
        self.authority, self.clock = authority, clock
        self.verify_native, self.verify_gesture, self.policy_gate = verify_native, verify_gesture, policy_gate
        self._producers, self._tickets, self._exposed = {}, {}, {}
        self._lock = threading.RLock()
        # Explicit composition starts with no inherited registration, even under the same epoch.
        authority.db._execute_write(lambda conn: conn.execute('UPDATE stellar_bg_producers_v1 SET active=0'))

    def register_producer(self, producer_id, *, version, incarnation):
        """Host loader only, after verifying the producer artifact; not an RPC/tool method."""
        text(producer_id, 256, identifier=True)
        text(version, 256, identifier=True)
        Origin('p', 's', 's', 'r', producer_id, incarnation).validate()
        with self._lock:
            if producer_id in self._producers:
                raise ContractError('producer_already_registered')
            port = Producer(self, producer_id, version, incarnation)
            def register(conn):
                if not self._enabled(conn):
                    raise ContractError('installation_disabled')
                old = conn.execute('SELECT version FROM stellar_bg_versions_v1 WHERE producer_id=? AND incarnation=?',
                                   (producer_id, incarnation)).fetchone()
                if old is not None and old[0] != version:
                    raise ContractError('producer_identity_conflict')
                if old is None:
                    if conn.execute('SELECT count(*) FROM stellar_bg_versions_v1').fetchone()[0] >= 20:
                        raise ContractError('producer_capacity')
                    conn.execute('INSERT INTO stellar_bg_versions_v1 VALUES(?,?,?)', (producer_id, incarnation, version))
                conn.execute('INSERT INTO stellar_bg_producers_v1 VALUES(?,?,?,?,1) ON CONFLICT(producer_id) '
                    'DO UPDATE SET version=excluded.version,incarnation=excluded.incarnation,epoch=excluded.epoch,active=1',
                    (producer_id, version, incarnation, self.authority.epoch))
            self.authority.db._execute_write(register)
            self._producers[producer_id] = port
            return port

    def unregister_producer(self, port):
        with self._lock:
            if self._producers.get(port.producer) is not port:
                raise ContractError('permission_denied')
            self.authority.db._execute_write(lambda conn: conn.execute(
                'UPDATE stellar_bg_producers_v1 SET active=0 WHERE producer_id=?', (port.producer,)))
            del self._producers[port.producer]
            self._unexpose(port)

    def _unexpose(self, port):
        for manager in self._exposed.pop(port.producer, ()):
            ports = getattr(manager, '_stellar_background_ports', {})
            if ports.get(port.producer) is port:
                del ports[port.producer]

    def expose(self, manager, port):
        """Host loader injects only its own verified manager's immutable producer facade."""
        from hermes_constants import hermes_home_key
        if (self._producers.get(port.producer) is not port
                or manager.scope_key != hermes_home_key(self.authority.profile_id)):
            raise ContractError('permission_denied')
        ports = getattr(manager, '_stellar_background_ports', None)
        if ports is None:
            ports = manager._stellar_background_ports = {}
        if port.producer in ports:
            raise ContractError('producer_already_registered')
        ports[port.producer] = port
        self._exposed.setdefault(port.producer, []).append(manager)

    def detach(self):
        """Coordinator's disable: durable revoke first, retain all identity/effect tombstones."""
        from .lifecycle import disable
        with self._lock:
            result = self.authority.db._execute_write(disable)
            for port in self._producers.values():
                self._unexpose(port)
            self._producers.clear()
            self._tickets.clear()
        # Keep the host for original-owner finish/inspect. Do not remove while custody remains.
        return result

    def _ledger(self, producer):
        return Ledger(self.authority.db, producer_id=producer, profile_id=self.authority.profile_id,
                      gate=self._gate, clock=self.clock)

    async def settle_cancellations(self, binding_id, result):
        from .cancellations import pay
        return await pay(self, binding_id, result)

    async def detach_and_settle(self):
        """Live owner loop uses this tracked port; sync detach is for quiescent composition only."""
        from gateway.session_runtime_workers import tracked_write
        return await tracked_write(self.authority, self.detach,
            then=lambda result: self.settle_cancellations(None, result))

    @staticmethod
    def _enabled(conn):
        row = conn.execute('SELECT phase FROM stellar_bg_installation_v1 WHERE singleton=1').fetchone()
        return row is not None and row[0] in ('active_candidate', 'unmanaged_candidate')

    def _gate(self, conn, binding):
        origin = binding['origin']
        port = self._producers.get(origin['producerId'])
        authority = self.authority
        authority._require_admission_open()
        live = authority.sessions.get(origin['sessionId'])
        row = conn.execute('SELECT ended_at FROM sessions WHERE id=?', (origin['physicalTarget'],)).fetchone()
        registration = conn.execute('SELECT * FROM stellar_bg_producers_v1 WHERE producer_id=?',
                                    (origin['producerId'],)).fetchone()
        return (self._enabled(conn) and port is not None and port.incarnation == origin['workerIncarnation']
            and registration is not None and registration['active'] == 1
            and registration['epoch'] == authority.epoch and registration['version'] == port.version
            and registration['incarnation'] == port.incarnation
            and origin['profileId'] == authority.profile_id and live is not None
            and live.route == origin['route'] and not live.detached and row is not None and row[0] is None
            and authority.db._compression_tip_on(conn, origin['sessionId']) == origin['physicalTarget']
            and self.policy_gate(conn, binding, port.version) is True)

    def _native(self, connection, session_id, *, capability='session:control'):
        from gateway.session_contract import SessionRef
        authority, actor = self.authority, connection.actor
        if connection.authority is not authority:
            raise ContractError('permission_denied')
        ref = SessionRef(authority.profile_id, session_id)
        text(session_id, 512, identifier=True)
        authority.authorize(actor, ref, capability)
        # Legacy ownership registration alone also admits Webapp owners; it is insufficient.
        # verify_native must consume the existing authenticated transport gate, not JSON labels.
        if (getattr(authority, '_native_legacy_transports', {}).get(actor.transport_id) != actor
                or session_id not in connection.subscriptions
                or actor.transport_id not in authority.events or self.verify_native(connection) is not True):
            raise ContractError('permission_denied')
        return ref

    def approve(self, connection, session_id, *, producer_id, expires_at, max_admissions, gesture):
        """Trusted native UI adapter only. Verify a fresh explicit gesture outside model/tool RPC.

        Returns a 60-second, single-use ticket tied to this connection and original destination.
        The host verifier must consume a genuine native gesture; a truthy JSON field is invalid.
        """
        ref = self._native(connection, session_id)
        with self._lock:
            now = integer(self.clock())
            self._tickets = {k: v for k, v in self._tickets.items() if now < v['deadline']}
            if len(self._tickets) >= 16:
                raise ContractError('consent_capacity')
            port = self._producers.get(producer_id)
            if port is None:
                raise ContractError('producer_unavailable')
            live = self.authority.sessions[session_id]
            origin = Origin(self.authority.profile_id, session_id, self.authority.physical_target(ref),
                            live.route, producer_id, port.incarnation).validate()
            integer(expires_at, now + 1, now + 604800000)
            integer(max_admissions, 1, 100)
            options = {'expiresAt': expires_at, 'maxAdmissions': max_admissions, 'producerId': producer_id}
            if self.verify_gesture(connection, ref, options, gesture) is not True:
                raise ContractError('consent_unavailable')
            ticket = secrets.token_hex(32)
            self._tickets[ticket] = {'actor': connection.actor, 'origin': origin, 'options': options,
                                     'deadline': min(expires_at, now + 60000)}
            return ticket

    def bind(self, connection, session_id, ticket):
        self._native(connection, session_id)
        text(ticket, 64, identifier=True)
        with self._lock:
            grant = self._tickets.get(ticket)
            if (grant is None or grant['actor'] != connection.actor or self.clock() >= grant['deadline']
                    or grant['origin'].sessionId != session_id):
                raise ContractError('consent_unavailable')
            ledger = self._ledger(grant['origin'].producerId)
            with ledger.db._read_ctx() as conn:
                revision = conn.execute('SELECT COALESCE(MAX(revision),0)+1 FROM stellar_bg_bindings_v1').fetchone()[0]
            binding = ledger.bind(grant['origin'], consent_revision=revision,
                expires_at=grant['options']['expiresAt'], max_admissions=grant['options']['maxAdmissions'],
                _on_bind=lambda conn, b: conn.execute('INSERT INTO stellar_bg_owners_v1 VALUES(?,?)',
                    (b['bindingId'], connection.actor.subject)))
            del self._tickets[ticket]
            return binding


    def consumer(self, connection, session_id, binding_id, *, capability='session:control'):
        self._native(connection, session_id, capability=capability)
        if type(binding_id) is not str or re.fullmatch(r'[0-9a-f]{32}', binding_id) is None:
            raise ContractError('invalid_params')
        with self.authority.db._read_ctx() as conn:
            row = conn.execute('SELECT o.subject,b.origin_json FROM stellar_bg_owners_v1 o '
                'JOIN stellar_bg_bindings_v1 b USING(binding_id) WHERE binding_id=?', (binding_id,)).fetchone()
            import json
            origin = json.loads(row['origin_json']) if row is not None else {}
            if (row is None or row['subject'] != connection.actor.subject
                    or origin.get('sessionId') != session_id or origin.get('profileId') != self.authority.profile_id):
                raise ContractError('permission_denied')
        return Consumer(self, connection, session_id, binding_id, origin['producerId'])

    def ledger_for_row(self, conn, row):
        saved = conn.execute('SELECT b.origin_json FROM stellar_bg_events_v1 e JOIN stellar_bg_bindings_v1 b '
            'USING(binding_id) WHERE e.request_id=?', (row['request_id'],)).fetchone()
        if saved is None:
            raise ContractError('untrusted_descriptor')
        import json
        return self._ledger(json.loads(saved[0])['producerId'])


@dataclass(frozen=True)
class Producer:
    """Immutable host-issued plugin facade. Binding belongs to this registered incarnation."""
    _host: Host
    producer: str
    version: str
    incarnation: str

    def _ledger(self, binding_id):
        if self._host._producers.get(self.producer) is not self:
            raise ContractError('producer_unavailable')
        ledger = self._host._ledger(self.producer)
        with ledger.db._read_ctx() as conn:
            if ledger._get(conn, binding_id)['origin']['workerIncarnation'] != self.incarnation:
                raise ContractError('permission_denied')
        return ledger

    def prepare(self, binding_id, event):
        """Freeze/hash before durable local attempt logging; not an admission or retry promise."""
        import json
        ledger = self._ledger(binding_id)
        frozen = json.loads(canonical(event))
        with ledger.db._read_ctx() as conn:
            binding = ledger._get(conn, binding_id)
            ledger._valid(conn, binding)
            return {'event': frozen, 'digest': event_digest(binding, frozen)}

    async def submit(self, binding_id, event):
        from functools import partial
        from gateway.session_runtime_workers import tracked_write
        from gateway.session_contract import SessionRef
        ledger = self._ledger(binding_id)
        with ledger.db._read_ctx() as conn:
            sid = ledger._get(conn, binding_id)['origin']['sessionId']
        authority = self._host.authority
        ref = SessionRef(authority.profile_id, sid)
        return await tracked_write(authority,
            partial(ledger.submit, binding_id, event, epoch=authority.epoch),
            then=lambda value: (authority._publish_pending(ref), value)[1],
            ordered=True, after=partial(authority._schedule_admitted, ref))

    def inspect(self, binding_id, event_id, digest):
        return self._ledger(binding_id).inspect(binding_id, event_id, digest)


class Consumer:
    def __init__(self, host, connection, session_id, binding_id, producer):
        self.host, self.connection, self.session, self.binding = host, connection, session_id, binding_id
        self.ledger = host._ledger(producer)
        self.client = hashlib.sha256((connection.actor.subject + '\0' + connection.actor.transport_id).encode('utf-8')).hexdigest()

    def call(self, method, params):
        # Reauthorize every operation, including a handle retained after detach/reconnect.
        self.host.consumer(self.connection, self.session, self.binding,
            capability='session:read' if method == 'inspect' else 'session:control')
        if method == 'inspect':
            closed(params, ('eventId', 'digest'))
            return self.ledger.inspect(self.binding, params['eventId'], params['digest'])
        if method == 'effect.begin':
            closed(params, ('eventId', 'digest', 'operation', 'kind'))
            return self.ledger.begin_effect(self.binding, params['eventId'], params['digest'],
                client=self.client, operation=params['operation'], kind=params['kind'])
        if method == 'effect.finish':
            closed(params, ('eventId', 'operation', 'kind'))
            return self.ledger.finish_effect(self.binding, params['eventId'], client=self.client,
                operation=params['operation'], kind=params['kind'])
        if method == 'revoke':
            closed(params, ())
            return self.ledger.revoke(self.binding)
        raise ContractError('unknown_method')
