"""Atomic snapshot contract tests; projection is injected without copying PR #366."""
import json
import hashlib
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from . import overview_export
from .overview import snapshot
from .test_outcomes import metadata, receipt


class ExportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.destination = Path(self.temp.name) / 'snapshot.json'

    def tearDown(self):
        self.temp.cleanup()

    def projection(self):
        return {'coverage': 'confirmed receipts only', 'generated_at': 1795132800.5,
                'warnings': [], 'workers': [{'issue': 7, 'role': 'peon-cloud',
                    'claim_session': 'claim-x', 'runtime_session': None,
                    'incarnation': 'inc-1', 'terminal': 't7', 'process': 'exited',
                    'status': 'blocked', 'exit_code': 0, 'tests': 'unverified',
                    'review': 'unverified', 'merge': 'unverified',
                    'source': 'attempts/7/terminal.json', 'summary': 'incomplete',
                    'task': 'private', 'raw_log': 'private', 'reasoning': 'private'}]}

    def projection_import(self, data=None):
        return patch.object(overview_export.importlib, 'import_module',
                            return_value=SimpleNamespace(snapshot=lambda *_: data or self.projection()))

    def test_exports_allowlisted_projection_and_discards_private_fields(self):
        projection = self.projection()
        result = json.loads(overview_export._contract(projection))
        self.assertEqual(result['schemaVersion'], 1)
        self.assertEqual(result['workers'][0]['process'], 'exited')
        self.assertEqual(result['workers'][0]['status'], 'blocked')
        self.assertEqual(result['workers'][0]['exit_code'], 0)
        self.assertNotIn('task', result['workers'][0])
        self.assertNotIn('raw_log', result['workers'][0])
        self.assertNotIn('reasoning', result['workers'][0])

    def test_public_export_writes_real_projection_atomically(self):
        self.destination.write_bytes(b'{"old":true}')
        with self.projection_import():
            result = overview_export.export_snapshot(Path(self.temp.name), object(), self.destination)
        retained = json.loads(self.destination.read_text(encoding='utf-8'))
        self.assertTrue(result['available'])
        self.assertEqual(retained['generated_at'], 1795132800.5)
        self.assertEqual(retained['workers'][0]['claim_session'], 'claim-x')
        self.assertEqual(retained['workers'][0]['runtime_session'], None)
        self.assertNotIn('task', retained['workers'][0])
        self.assertNotIn('old', retained)
        self.assertFalse(list(self.destination.parent.glob('*.tmp')))

    def test_merged_issue366_projection_exports_for_snapshot_consumer(self):
        root = Path(self.temp.name)
        launch = receipt()
        directory = root / 'attempts' / f"{launch['issue']}-{hashlib.sha256(launch['claim_session'].encode()).hexdigest()}"
        directory.mkdir(parents=True)
        (directory / 'terminal.json').write_text(json.dumps(launch), encoding='utf-8')
        core = Mock()
        core.call.return_value = metadata()
        with patch.object(overview_export.importlib, 'import_module',
                          return_value=SimpleNamespace(
                              snapshot=lambda path, source: snapshot(path, source, clock=lambda: 1000))):
            result = overview_export.export_snapshot(root, core, self.destination)
        consumed = json.loads(self.destination.read_text(encoding='utf-8'))
        self.assertTrue(result['available'])
        self.assertIsInstance(consumed['generated_at'], (int, float))
        self.assertEqual(consumed['workers'][0]['process'], 'running')
        self.assertEqual(consumed['workers'][0]['status'], 'working')
        self.assertEqual(consumed['workers'][0]['runtime_session'], 'runtime-352')
        self.assertEqual(consumed['workers'][0]['review'], 'unverified')
        self.assertIn('stale', snapshot(root, core, clock=lambda: 1400)['workers'][0]['status'])

    def test_write_failure_preserves_prior_bytes_and_cleans_temporary(self):
        old = b'{"last_good":true}'
        self.destination.write_bytes(old)
        with self.projection_import(), patch.object(overview_export.os, 'replace', side_effect=OSError):
            result = overview_export.export_snapshot(Path(self.temp.name), object(), self.destination)
        self.assertFalse(result['available'])
        self.assertEqual(self.destination.read_bytes(), old)
        self.assertFalse(list(self.destination.parent.glob('*.tmp')))

    def test_cleanup_failure_does_not_replace_last_good_snapshot(self):
        old = b'{"last_good":true}'
        self.destination.write_bytes(old)
        with (self.projection_import(),
              patch.object(overview_export.os, 'replace', side_effect=OSError),
              patch.object(Path, 'unlink', side_effect=OSError)):
            result = overview_export.export_snapshot(Path(self.temp.name), object(), self.destination)
        self.assertFalse(result['available'])
        self.assertEqual(self.destination.read_bytes(), old)

    def test_projection_error_preserves_prior_bytes(self):
        old = b'{"last_good":true}'
        self.destination.write_bytes(old)
        with self.projection_import({'workers': [], 'generated_at': 'not-unix', 'coverage': 'scope'}):
            result = overview_export.export_snapshot(Path(self.temp.name), object(), self.destination)
        self.assertFalse(result['available'])
        self.assertEqual(self.destination.read_bytes(), old)

    def test_missing_projection_preserves_existing_bytes(self):
        old = b'{"retained":"last good"}'
        self.destination.write_bytes(old)
        with patch.object(overview_export.importlib, 'import_module', side_effect=ImportError):
            result = overview_export.export_snapshot(Path(self.temp.name), None, self.destination)
        self.assertFalse(result['available'])
        self.assertEqual(self.destination.read_bytes(), old)

    def test_oversized_snapshot_is_refused(self):
        with self.assertRaisesRegex(ValueError, '64 KiB'):
            overview_export._contract({'workers': [{'summary': 'x' * 70000}],
                                       'generated_at': 1795132800, 'coverage': 'bounded'})

    def test_worker_count_and_keys_are_bounded(self):
        result = overview_export._contract({'workers': [
            {'issue': n, 'private': 'discard'} for n in range(30)
        ], 'generated_at': 1795132800, 'coverage': 'bounded'})
        data = json.loads(result)
        self.assertEqual(len(data['workers']), 20)
        self.assertTrue(all('private' not in row for row in data['workers']))


if __name__ == '__main__':
    unittest.main()
