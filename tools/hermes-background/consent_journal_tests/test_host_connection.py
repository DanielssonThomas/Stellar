import copy
from unittest.mock import patch

import host_connection_v3
import journal_v3 as journal
from host_connection_v3._transaction import _TransactionWriter
from .host_fixtures import HostFixture
from .test_writer_failures import CommitFault


class HostConnectionTests(HostFixture):
    def test_public_factory_never_accepts_data_or_true_verifier(self):
        for args in [(), (self.original_fixture,), (self.context, self.scope), (lambda: True,)]:
            self.assertCode('host_connection_unavailable', lambda: host_connection_v3.attach(*args,
                authenticated=True, consent=True))

    def test_fixture_composes_single_bind_owner_revision_and_hash_only(self):
        self.prepare_host()
        binding = self.bind_host()
        self.assertEqual(binding['consentRevision'], 1)
        row = self.inspect()
        self.assertEqual(row['phase'], 'bound')
        self.assertEqual(row['binding_id'], binding['bindingId'])
        self.assertEqual(self.raw_count('stellar_bg_owners_v1'), 1)
        self.assertNotIn(self.ticket_data_fixture, str(row))
        self.assertIsNone(self.plan._ticket)
        self.assertCode('consent_uncertain', self.bind_host)
        self.assertEqual(self.raw_count('stellar_bg_bindings_v1'), 1)

    def test_revision_is_chosen_inside_canonical_writer_not_read_before_write(self):
        self.prepare_host()
        original = self.db._execute_write
        def another_binding_first(callback):
            self.ledger.bind(self.origin, consent_revision=7, expires_at=self.scope['expiresAt'], max_admissions=1)
            return original(callback)
        # Use the unchanged real writer for the competing fixture bind, avoiding wrapper recursion.
        self.ledger.db = journal.OneShotWriter(type('DBFixture', (), {'_execute_write': staticmethod(original)})())
        with patch.object(self.db, '_execute_write', another_binding_first):
            binding = self.bind_host()
        self.assertEqual(binding['consentRevision'], 8)
        self.assertEqual(self.raw_count('stellar_bg_bindings_v1'), 2)

    def test_wrong_original_object_even_equality_spoof_seals_before_db(self):
        class EqualFixture:
            def __eq__(self, other): return True
        self.assertCode('connection_changed', lambda: self.call('reserve', original=EqualFixture()))
        self.assertCode('consent_uncertain', lambda: self.call('reserve'))
        self.assertEqual(self.raw_count('stellar_nc_attempt_v3'), 0)

    def test_context_policy_generation_change_seals_before_writer(self):
        self.prepare_host('pending')
        changed = {**self.context, 'connectionGeneration': 2, 'policyDigest': '0' * 64}
        self.assertCode('context_changed', lambda: self.call('begin', context=changed))
        self.assertCode('consent_uncertain', lambda: self.call('begin'))
        self.assertEqual(self.inspect()['phase'], 'pending')

    def test_physical_destination_change_seals_and_snapshot_does_not_alias(self):
        returned = self.call('reserve')
        returned['origin']['physicalTarget'] = 'changed-returned-copy'
        self.assertEqual(self.plan._scope['origin']['physicalTarget'], 'original')
        changed = copy.deepcopy(self.scope)
        changed['origin']['physicalTarget'] = 'new-physical-tip'
        self.assertCode('context_changed', lambda: self.call('begin', prepared=changed))
        self.assertEqual(self.inspect()['phase'], 'pending')

    def test_constructor_freezes_original_mutable_input(self):
        self.scope['displayScope']['effects'].reverse()
        self.assertEqual(self.plan._scope['displayScope']['effects'], ['render', 'speech'])
        with self.assertRaises(journal.JournalError): self.call('reserve')
        self.scope['displayScope']['effects'].reverse()
        self.assertCode('consent_uncertain', lambda: self.call('reserve'))

    def test_release_replay_and_wrong_ticket_do_not_create_binding(self):
        self.prepare_host()
        self.assertCode('consent_uncertain', lambda: self.call('bind', '00' * 32))
        self.assertCode('consent_uncertain', self.bind_host)
        self.assertEqual(self.raw_count('stellar_bg_bindings_v1'), 0)

    def test_release_is_spent_even_if_caller_loses_return(self):
        self.prepare_host()
        self.assertCode('consent_uncertain', lambda: self.call('release'))
        self.assertCode('consent_uncertain', self.bind_host)
        self.assertEqual(self.inspect()['release_reserved'], 1)

    def test_stalled_wall_mono_ticket_expiry_and_challenge_expiry(self):
        self.prepare_host(deadline=self.now + 5000)
        self.mono_fixture += 5000
        self.assertCode('consent_expired', self.bind_host)
        self.assertEqual(self.raw_count('stellar_bg_bindings_v1'), 0)

    def test_stalled_wall_mono_challenge_expiry(self):
        self.prepare_host('pending')
        self.mono_fixture += 60000
        self.assertCode('consent_expired', lambda: self.call('begin'))

    def test_clock_rollback_stays_sealed(self):
        self.prepare_host('pending')
        self.now -= 1
        self.assertCode('clock_changed', lambda: self.call('begin'))
        self.now += 1
        self.assertCode('consent_uncertain', lambda: self.call('begin'))

    def test_invalid_clock_values_never_enter_writer(self):
        for bad in [True, -1, 1.0, float('inf'), float('nan'), 2**53]:
            with self.subTest(bad=bad):
                self.now = bad
                with self.assertRaises(journal.JournalError): self.new_plan()
        self.assertEqual(self.raw_count('stellar_nc_attempt_v3'), 0)

    def test_fresh_clock_after_writer_lock_delay_refuses_and_rolls_back(self):
        self.prepare_host()
        execute = self.db._execute_write
        def delayed(callback):
            self.mono_fixture += 10000
            return execute(callback)
        with patch.object(self.db, '_execute_write', delayed):
            self.assertCode('consent_expired', self.bind_host)
        self.assertEqual(self.raw_count('stellar_bg_bindings_v1'), 0)

    def test_post_commit_expiry_withholds_result_keeps_committed_bind_and_latch(self):
        self.prepare_host()
        execute = self.db._execute_write
        def late_return(callback):
            result = execute(callback)
            self.mono_fixture += 10000
            return result
        with patch.object(self.db, '_execute_write', late_return):
            self.assertCode('consent_expired', self.bind_host)
        self.assertEqual(self.inspect()['phase'], 'bound')
        self.assertCode('consent_uncertain', self.bind_host)
        self.assertEqual(self.cancel_host(), 'uncertain_revoking')
        self.assertTrue(self.plan._uncertain)

    def test_cancel_bound_preserves_retained_effect_and_exact_obligations(self):
        self.prepare_host()
        binding = self.bind_host()
        started = self.add_retained_work(binding)
        self.assertEqual(self.cancel_host(), 'uncertain_revoking')
        self.assertEqual(self.raw_count('stellar_bg_cancellations_v1'), 1)
        self.assertEqual(self.db._conn.execute('SELECT finished FROM stellar_bg_effects_v1').fetchone()[0], 0)
        self.assertEqual(self.db._conn.execute('SELECT status FROM session_admissions WHERE admission_id=?',
            (started['admission_id'],)).fetchone()[0], 'started')
        self.assertCode('consent_uncertain', self.bind_host)

    def test_cancel_before_bind_and_after_expiry_never_clears_latch(self):
        self.prepare_host()
        self.now += 1000000
        self.assertEqual(self.cancel_host(), 'uncertain_revoking')
        self.assertCode('consent_uncertain', self.bind_host)
        self.now -= 1000000
        self.plan = self.new_plan()
        self.assertCode('consent_uncertain', lambda: self.call('reserve'))
        self.assertEqual(self.raw_count('stellar_bg_bindings_v1'), 0)

    def test_transaction_facade_rejects_nested_repeated_and_escaped_use(self):
        retained = []
        def write(conn):
            facade = _TransactionWriter(conn)
            retained.append(facade)
            try:
                def nested(current):
                    self.assertIs(current, conn)
                    self.assertCode('write_uncertain', lambda: facade._execute_write(lambda _: None))
                facade._execute_write(nested)
                self.assertCode('write_uncertain', lambda: facade._execute_write(lambda _: None))
            finally: facade.close()
        self.write(write)
        self.assertCode('write_uncertain', lambda: retained[0]._execute_write(lambda _: None))

    def test_real_bind_commit_then_busy_never_replays_insertion_or_native_success(self):
        self.prepare_host()
        original = self.db._conn
        self.db._conn = CommitFault(original, after=True)
        try:
            with patch.object(self.db, '_sleep_before_write_retry', return_value=True):
                self.assertCode('write_uncertain', self.bind_host)
        finally: self.db._conn = original
        self.assertEqual(self.inspect()['phase'], 'bound')
        self.assertEqual(self.raw_count('stellar_bg_bindings_v1'), 1)
        self.assertCode('consent_uncertain', self.bind_host)
        self.assertEqual(self.cancel_host(), 'uncertain_revoking')
        self.assertTrue(self.plan._uncertain)
