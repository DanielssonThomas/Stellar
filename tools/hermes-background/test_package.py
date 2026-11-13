"""Adversarial install/disable/remove tests ONLY on enrolled temporary source copies."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[2]
EVIDENCE = {}


class PackageTests(unittest.TestCase):
    def setUp(self):
        from stellar_background.package import enroll
        from hermes_state import SessionDB
        self.temp = tempfile.TemporaryDirectory(prefix='stellar339-package-')
        self.addCleanup(self.temp.cleanup)
        self.package = enroll(RUNTIME, Path(self.temp.name))
        self.db = SessionDB(self.package.db_path)
        self.addCleanup(self.db.close)

    def assertCode(self, expected, operation):
        from stellar_background.contract import ContractError
        with self.assertRaises(ContractError) as caught:
            operation()
        self.assertEqual(caught.exception.code, expected)

    def probe(self, mode):
        result = subprocess.run([sys.executable, '-I', '-B', str(REPO / 'tools/hermes-background/package_probe.py'),
            '--root', str(self.package.root), '--source', str(RUNTIME), '--mode', mode], capture_output=True,
            text=True, encoding='utf-8', timeout=45)
        self.assertEqual(result.returncode, 0, result.stderr)
        value = json.loads(result.stdout)
        self.assertFalse(value['liveModelOrNotification'])
        return value['result']

    def snapshots(self):
        from stellar_background.package_io import digest
        return {str(p.relative_to(self.package.runtime)): digest(p.read_bytes())
            for p in self.package.runtime.rglob('*') if p.is_file()}

    def test_empty_install_disable_remove_restores_base_and_foreground(self):
        base = self.snapshots()
        installed = self.package.install(self.db)
        self.assertFalse(installed['installedCapability'])
        self.package.disable(self.db)
        removed = self.package.remove(self.db, restore_base=True)
        self.assertEqual(removed['phase'], 'removed')
        self.assertEqual(base, self.snapshots())
        self.assertEqual(self.probe('foreground')['outcome'], 'completed')
        EVIDENCE['emptyRemoval'] = removed

    def test_cold_installed_runtime_uses_pinned_package_and_retained_fence(self):
        self.package.install(self.db)
        example = self.probe('exercise')
        self.assertFalse(example['genuineConsent'])
        self.package.disable(self.db)
        self.assertCode('retained_provenance_requires_fence', lambda: self.package.remove(self.db, restore_base=True))
        removed = self.package.remove(self.db)
        self.assertEqual(removed['phase'], 'fenced')
        fenced = self.probe('fence')
        self.assertEqual(fenced['marker']['bindingId'], example['binding']['bindingId'])
        self.assertFalse(fenced['delivery'])
        self.assertTrue(fenced['producerModuleAbsent'])
        self.assertNotIn('stellar.background.v1', fenced['describe']['capabilities'])
        with self.db._read_ctx() as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM stellar_bg_events_v1').fetchone()[0], 1)
        EVIDENCE['retainedRemoval'] = {'fixture': example, 'removed': removed, 'receiptFence': fenced}

    def test_unfinished_custody_blocks_removal_until_exact_fixture_owner_ack(self):
        from stellar_background.ledger import Ledger
        self.package.install(self.db)
        example = self.probe('exercise')
        owner = Ledger(self.db, producer_id='stellar-herdr', profile_id='fixture-ivy', gate=lambda c, b: True,
                       clock=lambda: 1700000000000)
        binding, event = example['binding']['bindingId'], example['event']['eventId']
        # Kernel custody fixture, same owner object throughout. No new transport claims old custody.
        self.assertTrue(owner.begin_effect(binding, event, example['digest'], client='synthetic-fixture-owner',
                                          operation='fixture-op', kind='speech')['execute'])
        self.package.disable(self.db)
        before = self.snapshots()
        self.assertCode('custody_or_execution_pending', lambda: self.package.remove(self.db))
        self.assertEqual(before, self.snapshots())
        self.assertCode('effect_owner_mismatch', lambda: owner.finish_effect(binding, event,
            client='another-fixture-owner', operation='fixture-op', kind='speech'))
        owner.finish_effect(binding, event, client='synthetic-fixture-owner', operation='fixture-op', kind='speech')
        self.assertEqual(self.package.remove(self.db)['phase'], 'fenced')

    def test_install_crash_after_known_write_resumes_without_replaying_work(self):
        def crash(phase):
            if phase.startswith('installed:'):
                raise ConnectionError('fixture installer interrupted')
        with self.assertRaises(ConnectionError):
            self.package.install(self.db, failpoint=crash)
        with self.db._read_ctx() as conn:
            self.assertEqual(conn.execute('SELECT phase FROM stellar_bg_installation_v1').fetchone()[0], 'installing')
        self.assertEqual(self.package.install(self.db)['phase'], 'installed')
        self.assertEqual(self.probe('exercise')['event']['eventId'], 'disposable-event')

    def test_partial_install_rollback_preserves_db_fences_and_foreground(self):
        before = self.snapshots()
        def crash(phase):
            if phase.startswith('installed:'):
                raise ConnectionError('fixture install lost ACK')
        with self.assertRaises(ConnectionError):
            self.package.install(self.db, failpoint=crash)
        self.assertEqual(self.package.rollback_install(self.db)['phase'], 'removed')
        self.assertEqual(before, self.snapshots())
        with self.db._read_ctx() as conn:
            self.assertIsNotNone(conn.execute("SELECT 1 FROM sqlite_master WHERE name='stellar_bg_effects_v1'").fetchone())
        self.assertTrue(self.probe('foreground')['humanAdmissionMatches'])

    def test_remove_crash_resumes_known_preimages_only(self):
        self.package.install(self.db)
        self.package.disable(self.db)
        def crash(phase):
            if phase.startswith('restored:'):
                raise ConnectionError('fixture remove lost ACK')
        with self.assertRaises(ConnectionError):
            self.package.remove(self.db, failpoint=crash)
        self.assertEqual(self.package.remove(self.db)['phase'], 'removed')

    def test_phase_journal_loss_reconciles_only_verified_adjacent_images(self):
        def crash(phase):
            if phase == 'install_db_intent':
                raise ConnectionError('fixture before journal intent')
        with self.assertRaises(ConnectionError):
            self.package.install(self.db, failpoint=crash)
        self.assertEqual(self.package.recover(self.db)['phase'], 'installing')
        def crash_final(phase):
            if phase == 'install_db_active':
                raise ConnectionError('fixture after DB commit before journal')
        with self.assertRaises(ConnectionError):
            self.package.install(self.db, failpoint=crash_final)
        self.assertEqual(self.package.recover(self.db)['phase'], 'installed')
        self.package.disable(self.db)
        def crash_remove(phase):
            if phase == 'remove_db_complete':
                raise ConnectionError('fixture before final remove journal')
        with self.assertRaises(ConnectionError):
            self.package.remove(self.db, failpoint=crash_remove)
        self.assertEqual(self.package.recover(self.db)['phase'], 'removed')

    def test_rollback_interruption_resumes_with_no_database_rollback(self):
        def crash(phase):
            if phase.startswith('installed:'):
                raise ConnectionError('fixture partial install')
        with self.assertRaises(ConnectionError):
            self.package.install(self.db, failpoint=crash)
        def crash_rollback(phase):
            if phase == 'rollback_db_intent':
                raise ConnectionError('fixture rollback intent')
        with self.assertRaises(ConnectionError):
            self.package.rollback_install(self.db, failpoint=crash_rollback)
        self.assertEqual(self.package.recover(self.db)['phase'], 'rolling_back')
        self.assertEqual(self.package.rollback_install(self.db)['phase'], 'removed')

    def test_interrupted_reinstall_recovers_and_fenced_removal_is_idempotent(self):
        self.package.install(self.db)
        self.package.disable(self.db)
        self.package.remove(self.db)
        def crash(phase):
            if phase == 'install_db_intent':
                raise ConnectionError('fixture reinstall interrupted')
        with self.assertRaises(ConnectionError):
            self.package.install(self.db, failpoint=crash)
        self.assertEqual(self.package.recover(self.db)['phase'], 'installing')
        self.package.install(self.db)
        self.probe('exercise')
        self.package.disable(self.db)
        self.package.remove(self.db)
        journal = (self.package.root / 'stellar-disposable-package.json').read_bytes()
        self.assertEqual(self.package.remove(self.db)['phase'], 'fenced')
        self.assertEqual(journal, (self.package.root / 'stellar-disposable-package.json').read_bytes())

    def test_fsync_interruption_and_unknown_staging_remain_inert(self):
        import stellar_background.package_io as io
        with patch.object(io.os, 'fsync', side_effect=ConnectionError('fixture fsync interrupted')):
            with self.assertRaises(ConnectionError):
                io.atomic(self.package.root, 'fixture-fsync.txt', b'non-executable diagnostic')
        io.atomic(self.package.root, 'fixture-fsync.txt', b'non-executable diagnostic')
        staging = self.package.root / 'package-staging'
        (staging / 'unknown-evidence.pending').write_bytes(b'untrusted orphan, retained only')
        self.package.install(self.db)
        self.assertEqual((staging / 'unknown-evidence.pending').read_bytes(), b'untrusted orphan, retained only')

    def test_wrong_package_install_and_rollback_refuse_without_db_or_file_mutation(self):
        from stellar_background.schema import install_schema
        install_schema(self.db)
        self.db._execute_write(lambda c: c.execute("UPDATE stellar_bg_installation_v1 SET package_digest='foreign'"))
        before = self.snapshots()
        with self.db._read_ctx() as conn:
            database = list(conn.iterdump())
        self.assertCode('database_package_mismatch', lambda: self.package.install(self.db))
        with self.db._read_ctx() as conn:
            self.assertEqual(database, list(conn.iterdump()))
        self.assertEqual(before, self.snapshots())
        self.db._execute_write(lambda c: c.execute("UPDATE stellar_bg_installation_v1 SET package_digest=''"))
        def crash(phase):
            if phase.startswith('installed:'):
                raise ConnectionError('fixture install interrupted')
        with self.assertRaises(ConnectionError):
            self.package.install(self.db, failpoint=crash)
        self.db._execute_write(lambda c: c.execute("UPDATE stellar_bg_installation_v1 SET package_digest='foreign'"))
        before = self.snapshots()
        with self.db._read_ctx() as conn:
            database = list(conn.iterdump())
        self.assertCode('database_package_mismatch', lambda: self.package.rollback_install(self.db))
        with self.db._read_ctx() as conn:
            self.assertEqual(database, list(conn.iterdump()))
        self.assertEqual(before, self.snapshots())

    def test_executable_lifecycle_cli_and_indirect_home_refusal(self):
        self.package.install(self.db)
        command = [sys.executable, '-I', '-B', str(REPO / 'tools/hermes-background/package_fixture.py'),
            'verify', '--root', str(self.package.root), '--source', str(RUNTIME)]
        result = subprocess.run(command, capture_output=True, text=True, encoding='utf-8', timeout=45)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(json.loads(result.stdout)['installedCapability'])
        home = self.package.root / 'fixture-home'
        from stellar_background.package_io import within
        # Preserve every fixture cache byte; replace only its directory entry with a test link.
        within(self.package.root, 'fixture-home').rename(within(self.package.root, 'saved-fixture-home'))
        target = self.package.root / 'indirect-home-target'
        target.mkdir()
        if os.name == 'nt':
            import _winapi
            _winapi.CreateJunction(str(target), str(home))
        else:
            home.symlink_to(target, target_is_directory=True)
        result = subprocess.run(command, capture_output=True, text=True, encoding='utf-8', timeout=45)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout)['error'], 'indirect_path_refused')
        self.assertFalse(list(target.iterdir()))
        self.assertEqual(home.resolve(), target.resolve())
        home.rmdir() if os.name == 'nt' else home.unlink()

    def test_retained_operator_works_when_current_operator_version_is_rejected(self):
        import stellar_background.package as module
        self.package.install(self.db)
        with patch.object(module, 'package_digest', return_value='different-operator-version'):
            self.assertCode('enrollment_mismatch', lambda: module.Package(self.package.root))
            command = [sys.executable, '-I', '-B', str(self.package.root / 'bundle/fixture-entry.py'),
                'verify', '--root', str(self.package.root), '--source', str(RUNTIME)]
            result = subprocess.run(command, capture_output=True, text=True, encoding='utf-8', timeout=45)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(json.loads(result.stdout)['installedCapability'])

    def test_executable_cli_prepare_install_disable_remove_roundtrip(self):
        root = self.package.root / 'cli-roundtrip'
        root.mkdir()
        results = []
        for operation in ('prepare', 'install', 'verify', 'disable', 'remove'):
            entry = REPO / 'tools/hermes-background/package_fixture.py' if operation == 'prepare' else root / 'bundle/fixture-entry.py'
            command = [sys.executable, '-I', '-B', str(entry), operation, '--root', str(root), '--source', str(RUNTIME)]
            result = subprocess.run(command, capture_output=True, text=True, encoding='utf-8', timeout=45)
            self.assertEqual(result.returncode, 0, result.stderr)
            value = json.loads(result.stdout)
            self.assertFalse(value['installedCapability'])
            results.append({'operation': operation, 'phase': value['result']['phase']})
        from stellar_background.provenance import verify_runtime
        self.assertFalse(verify_runtime(root / 'runtime')['installedCapability'])
        self.assertTrue((root / 'state/canonical.db').exists())
        EVIDENCE['executableCliRoundtrip'] = results

    def test_canonical_unknown_execution_refuses_removal_without_resend(self):
        self.package.install(self.db)
        self.probe('exercise')
        self.package.disable(self.db)
        self.db._execute_write(lambda c: c.execute("UPDATE session_admissions SET status='unknown'"))
        before = self.snapshots()
        self.assertCode('custody_or_execution_pending', lambda: self.package.remove(self.db))
        self.assertEqual(before, self.snapshots())

    def test_unknown_update_and_foreign_db_refuse_without_source_changes(self):
        from hermes_state import SessionDB
        self.package.install(self.db)
        path = self.package.runtime / 'hermes_state_runtime.py'
        path.write_bytes(path.read_bytes() + b'\n# unrelated fixture update\n')
        before = self.snapshots()
        self.package.disable(self.db)  # opt-out is still possible; never overwrites unknown source
        self.assertCode('source_mismatch', lambda: self.package.remove(self.db))
        self.assertEqual(before, self.snapshots())
        foreign = SessionDB(Path(self.temp.name) / 'foreign.db')
        try:
            self.assertCode('foreign_database_refused', lambda: self.package.verify(foreign))
        finally:
            foreign.close()

    def test_wrong_database_package_identity_refuses_before_any_mutation(self):
        self.package.install(self.db)
        self.db._execute_write(lambda c: c.execute("UPDATE stellar_bg_installation_v1 SET package_digest='other-package'"))
        before, journal = self.snapshots(), (self.package.root / 'stellar-disposable-package.json').read_bytes()
        self.assertCode('database_package_mismatch', lambda: self.package.disable(self.db))
        self.assertEqual(before, self.snapshots())
        self.assertEqual(journal, (self.package.root / 'stellar-disposable-package.json').read_bytes())

    def test_runtime_lease_refuses_mutation(self):
        self.package.install(self.db)
        with self.package.runtime_use(self.db):
            self.assertCode('runtime_in_use', lambda: self.package.disable(self.db))

    def test_orphaned_atomic_staging_does_not_block_resume_or_rollback(self):
        import stellar_background.package_io as io
        target = self.package.root / 'fixture-atomic.txt'
        with patch.object(io.os, 'replace', side_effect=ConnectionError('fixture before rename')):
            with self.assertRaises(ConnectionError):
                io.atomic(self.package.root, 'fixture-atomic.txt', b'first')
        self.assertFalse(target.exists())
        io.atomic(self.package.root, 'fixture-atomic.txt', b'first')
        self.assertEqual(target.read_bytes(), b'first')
        self.assertTrue(list((self.package.root / 'package-staging').iterdir()))
        self.assertEqual(self.package.install(self.db)['phase'], 'installed')

    def test_enrollment_refuses_nonempty_or_indirect_targets(self):
        from stellar_background.package import enroll
        self.assertCode('fresh_disposable_required', lambda: enroll(RUNTIME, self.package.root))
        self.assertCode('disposable_root_required', lambda: enroll(RUNTIME, REPO))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime', type=Path, required=True)
    parser.add_argument('--evidence', type=Path)
    args, rest = parser.parse_known_args()
    RUNTIME = args.runtime.resolve(strict=True)
    sys.dont_write_bytecode = True
    sys.path[:0] = [str(REPO / 'config/hermes-compat/stellar-background-v1'), str(RUNTIME)]
    with tempfile.TemporaryDirectory(prefix='stellar339-package-home-') as home:
        for key in ('HERMES_HOME', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA'):
            os.environ[key] = home
        result = unittest.main(argv=[sys.argv[0], *rest], verbosity=2, exit=False).result
        if args.evidence:
            output = args.evidence.resolve()
            if not output.is_relative_to(REPO / 'artifacts/issue-339'):
                raise ValueError('evidence must remain in this issue artifacts')
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps({'disposableOnly': True, 'nativeFixturesOnly': True,
                'genuineConsent': False, 'managedApplied': False, 'testsRun': result.testsRun,
                'passed': result.wasSuccessful(), 'evidence': EVIDENCE}, indent=2) + '\n', encoding='utf-8')
        sys.exit(not result.wasSuccessful())
