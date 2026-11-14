"""Local producer bookkeeping invariants; composed host execution has separate integration tests."""
from copy import deepcopy
import asyncio
import json
from pathlib import Path
import tempfile
import time
import unittest
from types import SimpleNamespace

from .core import Unavailable
from .notification_store import NotificationStore
from .notification_producer import NotificationProducer
from .observation_store import ObservationStore
from .test_observation import receipt, facts


class NotificationStoreTests(unittest.TestCase):
    def test_expiry_negotiation_keeps_legacy_shape_and_original_session_authorization(self):
        self.store.reserve_event(self.ident, self.now)
        saved = self.store.lookup(self.ident)
        clock, calls, reads = [self.now], [], []
        async def call(action, **params):
            calls.append(action)
            clock[0] = json.loads(saved['content'])['observedAt'] + 300.01
            return {'status': 'unknown', 'binding': self.binding,
                    'event_id': self.ident, 'delivery_allowed': False}
        def read_clock():
            reads.append(clock[0])
            return clock[0]
        producer = NotificationProducer(self.root, SimpleNamespace(notification=call), clock=read_clock)
        producer.store = lambda: (self.store, {})
        args = {'event_id': self.ident}
        legacy = asyncio.run(producer.rpc_inspect(args, session_id='fixture-original'))
        self.assertEqual(set(legacy), {'host', 'local_eligible', 'delivery_allowed'})
        result = asyncio.run(producer.rpc_inspect({**args, 'include_expiry': True}, session_id='fixture-original'))
        self.assertTrue(result['local_expired'])
        self.assertFalse(result['local_eligible'])
        self.assertFalse(result['delivery_allowed'])
        self.assertEqual(result['host'], legacy['host'])
        for invalid in (False, 1, 'true', None):
            with self.assertRaises(Unavailable):
                asyncio.run(producer.rpc_inspect({**args, 'include_expiry': invalid}, session_id='fixture-original'))
        with self.assertRaises(Unavailable):
            asyncio.run(producer.rpc_inspect({**args, 'include_expiry': True}, session_id='foreign'))
        with self.assertRaises(Unavailable):
            asyncio.run(producer.rpc_revoke({**args, 'include_expiry': True}, session_id='fixture-original'))
        self.assertEqual(calls, ['inspect', 'inspect'])
        self.assertEqual(len(reads), 2)
        self.assertEqual(self.store.lookup(self.ident)['content'], saved['content'])
        self.assertEqual(self.store.lookup(self.ident)['phase'], 'unknown')

    def test_immutable_expiry_survives_healthy_polls_and_transition_pruning(self):
        self.store.reserve_event(self.ident, self.now)
        saved = self.store.lookup(self.ident)
        content = json.loads(saved['content'])
        horizon = content['observedAt'] + 300
        self.assertFalse(self.store.expired(saved, horizon))
        self.assertTrue(self.store.expired(saved, horizon + .001))
        with self.observer.transaction() as db:
            db.execute("UPDATE tracking SET health='current',observed=?", (horizon + 1,))
            db.execute('DELETE FROM transitions WHERE identity=?', (self.ident,))
        self.assertTrue(self.store.expired(self.store.lookup(self.ident), horizon + 1))
        retained = self.store.lookup(self.ident)
        self.assertFalse(self.store.expired(retained, horizon - .001))
        self.assertEqual(retained['phase'], 'unknown')
        self.assertEqual(retained['content'], saved['content'])
        self.assertEqual(retained['binding'], saved['binding'])

    def test_expiry_uses_strict_binding_deadline_and_rejects_corrupt_timestamps(self):
        self.store.reserve_event(self.ident, self.now)
        original = self.store.lookup(self.ident)
        saved = dict(original)
        content, binding = json.loads(saved['content']), json.loads(saved['binding'])
        binding['expires_at'] = content['observedAt'] + 100
        content['validUntil'] = binding['expires_at']
        saved.update(content=json.dumps(content), binding=json.dumps(binding))
        self.assertFalse(self.store.expired(saved, binding['expires_at'] - .001))
        self.assertTrue(self.store.expired(saved, binding['expires_at']))
        for field in ('observedAt', 'validUntil'):
            for invalid in (True, None, float('nan'), float('inf'), -1, '300'):
                bad = dict(saved)
                bad['content'] = json.dumps({**content, field: invalid})
                with self.assertRaises(Unavailable):
                    self.store.expired(bad, self.now)
        bad = dict(saved, content=json.dumps({**content, 'validUntil': content['validUntil'] + 1}))
        with self.assertRaises(Unavailable):
            self.store.expired(bad, self.now)
        for clock in (True, float('nan'), float('inf')):
            with self.assertRaises(Unavailable):
                self.store.expired(saved, clock)

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.store = NotificationStore(self.root)
        self.observer = ObservationStore(self.root)
        self.now = time.time()
        revision = self.observer.enable(receipt(), ['worker_exited'], facts(), self.now, 0)
        self.track = self.store.current(23)
        self.binding = {'profile_id': str(self.root), 'session_id': 'fixture-physical',
            'owner_session_id': 'fixture-original', 'session_key': 'fixture-route', 'plugin_id': 'stellar-herdr',
            'tracking_id': receipt()['incarnation'], 'revision': revision,
            'expires_at': self.track['expires'], 'binding_id': '0'*64}
        self.store.save_binding(self.track, self.binding, self.now)
        self.ident = self.observe(0)

    def observe(self, code):
        self.now += 61
        reserved = self.observer.reserve(self.now)
        self.assertIsNotNone(reserved)
        bundle = facts()
        bundle['worker'] = {'state': 'finished', 'exit_code': code, 'blocked': False}
        self.observer.finish(reserved, bundle, self.now)
        return next(row['identity'] for row in self.observer.status(self.now)['transitions']
                    if row['fact'] == {'exit_code': code})

    def test_unknown_is_reserved_once_frozen_and_retained_after_optout(self):
        self.assertTrue(self.store.reserve_event(self.ident, self.now))
        self.assertFalse(self.store.reserve_event(self.ident, self.now))
        saved = self.store.lookup(self.ident)
        self.assertEqual(saved['phase'], 'unknown')
        self.observer.disable(23)
        self.store.sync(self.now)
        retained = self.store.lookup(self.ident)
        self.assertEqual(retained['content'], saved['content'])
        self.assertEqual(retained['binding_phase'], 'revoke_pending')
        self.assertFalse(self.store.eligible(self.ident, self.now))

    def test_known_receipt_is_monotone_and_conflicts_do_not_replace_evidence(self):
        self.store.reserve_event(self.ident, self.now)
        reply = {'status': 'known', 'descriptor': {'fixture': True}, 'receipt': {
            'admission_id': 'fixture-admission', 'ref': {'profile_id': str(self.root), 'session_id': 'fixture-original'},
            'sequence': 1, 'status': 'queued', 'outcome': None, 'authority_epoch': 1, 'execution_generation': None}}
        self.store.remember(self.ident, reply)
        terminal = deepcopy(reply)
        terminal['receipt'].update(status='terminal', outcome='completed', execution_generation=1)
        self.store.remember(self.ident, terminal)
        self.store.remember(self.ident, reply)
        retained = json.loads(self.store.lookup(self.ident)['outcome'])
        self.assertEqual(retained, terminal)
        changed = deepcopy(terminal)
        changed['receipt']['admission_id'] = 'another-admission'
        with self.assertRaises(Unavailable):
            self.store.remember(self.ident, changed)
        self.assertEqual(json.loads(self.store.lookup(self.ident)['outcome']), terminal)

    def test_late_binding_ack_cannot_reactivate_revoked_revision(self):
        self.store.reserve_event(self.ident, self.now)
        saved = self.store.lookup(self.ident)
        self.store.disable_binding(saved)
        self.store.save_binding(self.track, self.binding, self.now)
        self.assertEqual(self.store.lookup(self.ident)['binding_phase'], 'revoke_pending')
        self.store.revoked(saved, {'binding': self.binding, 'revoked': True, 'in_flight': []})
        self.store.save_binding(self.track, self.binding, self.now)
        self.assertEqual(self.store.lookup(self.ident)['binding_phase'], 'revoked')

    def test_expiry_and_supersession_derive_revocation_without_clearing_unknown(self):
        self.store.reserve_event(self.ident, self.now)
        self.observer.enable(receipt(), ['worker_exited'], facts(), self.now, self.observer.consent_revision())
        self.store.sync(self.now)
        self.assertEqual(self.store.lookup(self.ident)['binding_phase'], 'revoke_pending')
        self.store.sync(self.track['expires'] + 1)
        self.assertEqual(self.store.lookup(self.ident)['phase'], 'unknown')

    def test_actual_retry_exhaustion_disables_and_marks_revocation(self):
        self.store.reserve_event(self.ident, self.now)
        for _ in range(6):
            with self.observer.transaction() as db:
                due = db.execute('SELECT next_poll FROM tracking').fetchone()[0]
            self.now = max(self.now, due)
            reserved = self.observer.reserve(self.now)
            self.assertIsNotNone(reserved)
            self.observer.finish(reserved, None, self.now)
        self.store.sync(self.now)
        self.assertEqual(self.store.lookup(self.ident)['binding_phase'], 'revoke_pending')

    def test_actual_journal_full_disable_marks_revocation(self):
        self.store.reserve_event(self.ident, self.now)
        for code in range(1, 101):
            self.now += 61
            reserved = self.observer.reserve(self.now)
            bundle = facts()
            bundle['worker'] = {'state': 'finished', 'exit_code': code, 'blocked': False}
            self.observer.finish(reserved, bundle, self.now)
        self.store.sync(self.now)
        self.assertEqual(self.store.lookup(self.ident)['binding_phase'], 'revoke_pending')
        self.assertEqual(self.store.lookup(self.ident)['phase'], 'unknown')

    def test_unknown_poll_rotation_does_not_starve_new_event(self):
        self.store.reserve_event(self.ident, self.now)
        for code in range(1, 5):
            event_id = self.observe(code)
            self.store.reserve_event(event_id, self.now)
        new_event = self.observe(5)
        first = self.store.candidates(self.now)
        second = self.store.candidates(self.now)
        self.assertIn(new_event, first + second)


if __name__ == '__main__':
    unittest.main()
