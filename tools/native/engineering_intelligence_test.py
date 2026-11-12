"""Verify the broker read contract against the writer's migrations."""
from contextlib import closing
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'apps/stellar-desktop/src-tauri/src/ivy'
FIXTURES = ROOT / 'tools/native/fixtures'
MIGRATIONS = ROOT / 'tools/engineering-intelligence/migrations'


def load(name):
    spec = importlib.util.spec_from_file_location(name, SOURCE / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


reader = load('engineering_intelligence')
stage = load('engineering_presentation')
protocol = load('workspace_protocol')


def populate(path):
    with closing(sqlite3.connect(path)) as db:
        db.executescript('PRAGMA foreign_keys=ON; PRAGMA application_id=0x53544549; PRAGMA user_version=1;')
        for name in ('001-tables.sql', '001-views.sql'):
            db.executescript((MIGRATIONS / name).read_text(encoding='utf-8'))
        db.executescript((FIXTURES / 'engineering-intelligence.sql').read_text(encoding='utf-8'))


class TestEngineeringIntelligence(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / 'engineering.sqlite'
        populate(self.path)

    def read(self, **query):
        result = reader.read_summary(reader.validate_query(**query), self.path)
        self.assertEqual(result['state'], 'available')
        return result

    def test_budget_measures_history_per_model_with_partial_and_unavailable_usage(self):
        data = self.read(view='budget', issue_number=342)['data']['budget']
        issue = data['issues']['rows'][0]
        self.assertEqual((issue['baseline_tokens'], issue['estimated_tokens'], issue['observed_tokens']), (1200, 1400, 1800))
        self.assertEqual((issue['over_budget'], issue['baseline_variance_tokens'], issue['complete_sessions']), (1, None, 2))
        self.assertEqual(issue['observed_variance_tokens'], 600)
        scoped = self.read(view='budget', days=3650)['data']['budget']
        self.assertIn('Whole-session token totals', scoped['usage_window'])
        self.assertEqual([row['revision'] for row in data['revisions']['rows']], [2, 1])
        self.assertEqual({row['model'] for row in data['usage_by_model']['rows']}, {'model-a', 'model-b', 'model-c'})
        ivy = data['ivy_reported_usage']['rows'][0]
        self.assertEqual((ivy['agent'], ivy['observed_tokens'], ivy['cached_tokens']), ('ivy', 320, None))
        self.assertIsNone(data['api_equivalent_cost'])
        self.assertIsNone(data['estimated_allowance_impact'])
        self.assertEqual(data['subscription_allowance']['rows'], [])
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute('UPDATE usage_streams SET model=NULL,provider=NULL WHERE session_id=? AND id=?',
                       ('codex:fixture-342', 'a'))
            db.execute('INSERT INTO allowance_observations VALUES (?,?,?,?,?)',
                       ('codex', 300, '2026-11-11T16:00:00.000Z', '2026-11-11T14:30:00.000Z', 17.25))
        updated = self.read(view='budget', issue_number=342)['data']['budget']
        self.assertEqual(updated['subscription_allowance']['rows'][0]['used_percent'], 17.25)
        unattributed = [row for row in updated['usage_by_model']['rows'] if row['model'] is None]
        self.assertEqual([(row['provider'], row['observed_tokens']) for row in unattributed], [(None, 1000)])

    def test_repeated_attempts_diagnostic_failures_and_incomplete_evaluation(self):
        report = self.read(view='patterns', fingerprint='rust-fixture-e0308')['data']['patterns']
        pattern = report['recurring']['rows'][0]
        self.assertEqual((pattern['failure_count'], pattern['diagnostic_count'], pattern['affected_issues']), (3, 1, 2))
        self.assertEqual((pattern['retries'], pattern['resolved'], pattern['associated_observed_tokens']), (1, 2, 2290))
        self.assertEqual(report['candidates']['rows'][0]['occurrences'], 3)
        scoped = self.read(view='patterns', fingerprint='rust-fixture-e0308', skill='rust-build',
                           skill_version='2')['data']['patterns']
        self.assertEqual(scoped['recurring']['rows'][0]['affected_issues'], 1)
        absent = self.read(view='patterns', fingerprint='rust-fixture-e0308', skill='rust-build',
                           skill_version='1')['data']['patterns']
        self.assertEqual(absent['recurring']['rows'], [])
        assessment = report['interventions']['rows'][0]
        self.assertEqual((assessment['evidence_status'], assessment['before_attempts'], assessment['after_attempts']),
                         ('incomplete', 4, None))
        session = self.read(view='sessions', issue_number=342, session_id='codex:fixture-342', limit=2)['data']['sessions']
        self.assertEqual(session['history']['rows'][0]['observed_tokens'], 1400)
        self.assertEqual([attempt['exit_code'] for attempt in session['attempts']['rows']], [0, 101])
        self.assertTrue(session['attempts']['more'])

    def test_skill_versions_estimates_and_observed_loading_remain_separate(self):
        rows = self.read(view='skills', skill='rust-build')['data']['skills']['versions']['rows']
        self.assertEqual([(row['version'], row['state']) for row in rows], [('2', 'maintained'), ('1', 'retired')])
        self.assertEqual((rows[0]['static_tokens'], rows[0]['loaded_tokens'], rows[0]['reference_tokens']), (140, 140, None))
        self.assertEqual((rows[1]['static_tokens'], rows[1]['loaded_tokens']), (200, None))
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute('INSERT INTO skill_versions VALUES (?,?,?,?,?,?)',
                       ('build-check', '1', 'hash-2', '2026-11-06T09:00:00.000Z', 140, 'fixture tokenizer'))
            db.execute('INSERT INTO skill_states VALUES (?,?,?,?,?)',
                       ('build-check', '1', '2026-11-06T09:00:00.000Z', 'maintained', None))
        identical = self.read(view='skills', skill='rust-build')['data']['skills']['identical_content']['rows']
        self.assertEqual(identical, [{'skill': 'build-check', 'version': '1', 'matching_skill': 'rust-build',
                                      'matching_version': '2'}])

    def test_missing_corrupt_and_incompatible_database_fail_closed(self):
        query = reader.validate_query()
        missing = self.path.parent / 'missing.sqlite'
        self.assertEqual(reader.read_summary(query, missing)['state'], 'unavailable')
        self.assertFalse(missing.exists())
        missing.write_bytes(b'not sqlite')
        self.assertEqual(reader.read_summary(query, missing)['state'], 'unavailable')
        with closing(sqlite3.connect(self.path)) as db:
            db.execute('PRAGMA application_id=1234')
        self.assertEqual(reader.read_summary(query, self.path)['state'], 'unavailable')
        for args in ({'view': 'sessions', 'session_id': 'a\' UNION SELECT 1'}, {'limit': 13},
                     {'view': 'skills', 'issue_number': 342}, {'view': 'budget', 'issue_number': True}):
            with self.assertRaises(ValueError):
                reader.validate_query(**args)

    def test_browser_fixture_matches_deterministic_spatial_output(self):
        report = self.read(limit=6)
        encoded = stage.score_json(report)
        operation = {'kind': 'present', 'score_json': encoded}
        self.assertEqual(protocol.validate_operation(operation), operation)
        fixture = json.loads((FIXTURES / 'engineering-intelligence-score.json').read_text(encoding='utf-8'))
        self.assertEqual(json.loads(encoded), fixture)
        score = stage.spatial_score(self.read(view='budget', issue_number=342))
        panel = score['prepare'][0]['panel']
        self.assertEqual(panel['source'], 'https://github.com/DanielssonThomas/Stellar/issues/342')
        self.assertNotIn('chart', [block['kind'] for block in panel['detail']['payload']['blocks']])


if __name__ == '__main__':
    unittest.main()
