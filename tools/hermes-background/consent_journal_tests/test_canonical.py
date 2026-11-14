import concurrent.futures
import threading
from unittest.mock import patch
from .fixtures import Fixture
import journal_v3 as journal


class CanonicalTests(Fixture):
    def test_corrupt_effect_cardinality_refuses_before_hook_and_keeps_denial_unknown(self):
        self.ready(); binding = self.bind()
        self.db._execute_write(lambda conn: conn.executemany('INSERT INTO stellar_bg_effects_v1 VALUES(?,?,?,?,?,0)',
            [(binding['bindingId'], f'corrupt-{i}', 'speech', 'synthetic', f'op-{i}') for i in range(201)]))
        called = []
        self.assertCode('canonical_capacity', lambda: self.cancel(lambda *args: called.append(1)))
        self.assertEqual(called, [])
        self.assertEqual(self.inspect()['deny_requested'], 0)
        self.assertEqual(self.raw_count('stellar_bg_effects_v1'), 201)
    def test_real_bind_owner_and_cancel_preserve_effect_custody(self):
        self.ready(); binding = self.bind(); started = self.add_retained_work(binding)
        self.assertEqual(self.cancel(), 'uncertain_revoking')
        self.assertEqual(self.inspect()['phase'], 'bound')
        self.assertEqual(self.inspect()['deny_requested'], 1)
        self.assertEqual(self.db._conn.execute('SELECT revoked FROM stellar_bg_bindings_v1').fetchone()[0], 1)
        self.assertEqual(self.db._conn.execute('SELECT finished FROM stellar_bg_effects_v1').fetchone()[0], 0)
        current = self.db._conn.execute('SELECT status FROM session_admissions WHERE admission_id=?',
            (started['admission_id'],)).fetchone()[0]
        self.assertEqual(current, 'started')
        self.assertEqual(self.raw_count('stellar_bg_cancellations_v1'), 1)
        self.assertEqual(self.cancel(), 'uncertain_revoking')

    def test_cancel_before_bind_rolls_back_fresh_binding_and_owner(self):
        self.ready(); self.cancel()
        self.assertCode('consent_uncertain', self.bind)
        self.assertEqual(self.raw_count('stellar_bg_bindings_v1'), 0)
        self.assertEqual(self.raw_count('stellar_bg_owners_v1'), 0)
        self.assertEqual(self.inspect()['phase'], 'issued')

    def test_wrong_or_lying_revocation_hooks_roll_back_every_change(self):
        self.ready(); binding = self.bind(); started = self.add_retained_work(binding)
        def corrupt(conn, key, attack):
            self.ledger._revoke_on(conn, key)
            if attack == 'finish': conn.execute('UPDATE stellar_bg_effects_v1 SET finished=1 WHERE binding_id=?', (key,))
            elif attack == 'delete': conn.execute('DELETE FROM stellar_bg_effects_v1 WHERE binding_id=?', (key,))
            elif attack == 'owner': conn.execute('UPDATE stellar_bg_owners_v1 SET subject=? WHERE binding_id=?', ('wrong', key))
            elif attack == 'started': conn.execute('UPDATE session_admissions SET generation=generation+1 WHERE admission_id=?', (started['admission_id'],))
        for attack in ('finish', 'delete', 'owner', 'started', 'noop'):
            hook = (lambda conn, key: None) if attack == 'noop' else lambda conn, key: corrupt(conn, key, attack)
            self.assertCode('revocation_mismatch', lambda: self.cancel(hook))
            self.assertEqual(self.inspect()['deny_requested'], 0)
            self.assertEqual(self.db._conn.execute('SELECT revoked FROM stellar_bg_bindings_v1').fetchone()[0], 0)
            self.assertEqual(self.db._conn.execute('SELECT finished FROM stellar_bg_effects_v1').fetchone()[0], 0)
            self.assertEqual(self.raw_count('stellar_bg_cancellations_v1'), 0)

    def test_fresh_callback_clock_accepts_lock_delay_but_not_expired_challenge(self):
        self.ready()
        original = self.db._execute_write
        def delayed(callback, **kwargs):
            self.now += 5000
            return original(callback, **kwargs)
        with patch.object(self.db, '_execute_write', delayed):
            binding = self.bind()
        self.assertLess(binding['createdAt'], self.now)
        self.assertEqual(self.inspect()['phase'], 'bound')

    def test_lock_delay_past_challenge_rejects_despite_earlier_binding_creation(self):
        self.ready()
        original = self.db._execute_write
        def delayed(callback, **kwargs):
            self.now += 60001
            return original(callback, **kwargs)
        with patch.object(self.db, '_execute_write', delayed):
            self.assertCode('consent_expired', self.bind)
        self.assertEqual(self.raw_count('stellar_bg_bindings_v1'), 0)
        self.assertEqual(self.raw_count('stellar_bg_owners_v1'), 0)
        self.assertEqual(self.inspect()['phase'], 'issued')

    def test_distinct_canonical_writers_bind_cancel_race_has_no_unrevoked_binding(self):
        from hermes_state import SessionDB
        self.ready()
        other = SessionDB(self.path); self.addCleanup(other.close); self.configure(other)
        barrier = threading.Barrier(2)
        def bind():
            barrier.wait()
            try: return self.bind()
            except journal.JournalError: return None
        def cancel():
            barrier.wait()
            return journal.write_once(other, lambda conn: journal.cancel_on(conn, self.challenge,
                self.context, self.ledger._revoke_on))
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            a, b = pool.submit(bind), pool.submit(cancel)
            a.result(timeout=15); b.result(timeout=15)
        row = self.inspect()
        self.assertEqual(row['deny_requested'], 1)
        bindings = self.db._conn.execute('SELECT revoked FROM stellar_bg_bindings_v1').fetchall()
        self.assertTrue(not bindings or all(r[0] == 1 for r in bindings))

    def test_distinct_writers_issue_cancel_race_cannot_record_ticket(self):
        from hermes_state import SessionDB
        self.reserve(); self.begin()
        other = SessionDB(self.path); self.addCleanup(other.close); self.configure(other)
        barrier = threading.Barrier(2)
        def issue():
            barrier.wait()
            try: self.issue()
            except journal.JournalError: pass
        def cancel():
            barrier.wait()
            journal.write_once(other, lambda conn: journal.cancel_on(conn, self.challenge, self.context))
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            a, b = pool.submit(issue), pool.submit(cancel)
            a.result(timeout=15); b.result(timeout=15)
        self.assertEqual(self.inspect()['deny_requested'], 1)
        self.assertCode('consent_uncertain', self.ticket)
