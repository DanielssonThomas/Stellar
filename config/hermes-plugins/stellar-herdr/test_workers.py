"""Tests for the Ivy worker admission and Herdr lifecycle boundary."""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from . import workers
from .core import Core, Unavailable


class WorkersTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.repo = self.root / 'stellar'
        self.cwd = self.root / 'stellar-issue-23'
        self.repo.mkdir()
        self.cwd.mkdir()
        self.settings = dict.fromkeys(('core', 'app', 'hermes', 'node', 'git', 'gh'), 'fixture')
        self.settings['repo'] = str(self.repo)
        self.claim = {
            'issue': 23, 'worker': 'worker:peon-cloud', 'sessionId': 'job-23',
            'state': 'active', 'expiresAt': '2099-01-01T00:00:00Z',
            'worktreePath': str(self.cwd), 'branch': 'issue/23-fix', 'target': 'develop',
        }
        self.issue = {
            'state': 'OPEN',
            'labels': ['worker:peon-cloud', 'status:in-progress', 'target:develop'],
        }

    def test_claim_must_match_local_lease_and_fresh_github_owner(self):
        with patch.object(workers, 'command', side_effect=[self.claim, self.issue]):
            self.assertEqual(
                workers.validate_claim(self.settings, 23, 'peon-cloud', 'job-23'),
                (self.cwd.resolve(), 'issue/23-fix', 'develop'),
            )
        with patch.object(workers, 'command', return_value=self.claim):
            with self.assertRaisesRegex(Unavailable, 'active claim does not match'):
                workers.validate_claim(self.settings, 23, 'foreman-cloud', 'job-23')
        with patch.object(workers, 'command', side_effect=[self.claim, {**self.issue, 'state': 'CLOSED'}]):
            with self.assertRaisesRegex(Unavailable, 'GitHub no longer'):
                workers.validate_claim(self.settings, 23, 'peon-cloud', 'job-23')

    def submit(self, core):
        return workers.submit(self.root, self.settings, core, 23, 'peon-cloud', 'job-23', 'Check affected lint.')

    def test_dispatch_keeps_task_out_of_arguments_and_refuses_repeat(self):
        core = Mock()
        core.terminals.return_value = []
        core.launch.return_value = 't42'
        with (patch.object(workers, 'command', side_effect=[self.claim, self.issue] * 2),
              patch.object(workers, 'git_text', side_effect=['issue/23-fix', 'abc'] * 2)):
            self.assertEqual(self.submit(core)['terminal'], 't42')
            with self.assertRaisesRegex(Unavailable, 'already has a launch receipt'):
                self.submit(core)
        core.launch.assert_called_once()
        issue, role, cwd, argv = core.launch.call_args.args
        self.assertEqual((issue, role, cwd), (23, 'peon-cloud', self.cwd.resolve()))
        self.assertEqual(argv[:4], ['fixture', '-p', 'peon-cloud', 'chat'])
        task_file = argv[argv.index('--query-file') + 1]
        self.assertIn('Check affected lint.', task_file.read_text(encoding='utf-8'))
        self.assertNotIn('Check affected lint.', argv)
        core.focus.assert_not_called()

    def test_ambiguous_launch_keeps_receipt_and_live_issue_blocks_other_launch(self):
        core = Mock()
        core.terminals.return_value = [{'issue': 23, 'state': 'live'}]
        core.launch.side_effect = Unavailable('timeout')
        with (patch.object(workers, 'command', side_effect=[self.claim, self.issue] * 3),
              patch.object(workers, 'git_text', side_effect=['issue/23-fix', 'abc'] * 3)):
            with self.assertRaisesRegex(Unavailable, 'already has a live'):
                self.submit(core)
            core.terminals.return_value = []
            with self.assertRaisesRegex(Unavailable, 'receipt was retained'):
                self.submit(core)
            with self.assertRaisesRegex(Unavailable, 'already has a launch receipt'):
                self.submit(core)
        core.launch.assert_called_once()

    def test_observation_keeps_terminal_output_out_of_automatic_context(self):
        core = Core(self.settings)
        with patch.object(core, 'call', return_value={'terminals': [
            {'name': 'stellar-23', 'address': 't2', 'state': 'live', 'text': 'untrusted'},
            {'name': 'stellar-1', 'address': 't1', 'state': 'finished', 'exit_code': 4},
            {'name': 'other', 'address': 't3', 'state': 'live'},
        ]}):
            with patch.object(workers, 'load', return_value=(self.root, self.settings)), patch.object(workers, 'Core', return_value=core):
                context = workers.observe(self.root)['context']
        payload = json.loads(context.splitlines()[-1])
        self.assertEqual(payload['active_count'], 1)
        self.assertEqual([item['issue'] for item in payload['workers']], [23, 1])
        self.assertEqual(payload['workers'][1]['exit_code'], 4)
        self.assertNotIn('untrusted', context)
        with (patch.object(workers, 'load', return_value=(self.root, self.settings)),
              patch.object(core, 'call', side_effect=Unavailable()),
              patch.object(workers, 'Core', return_value=core)):
            self.assertIn('unavailable', workers.observe(self.root)['context'])

    def test_hide_only_controls_window_and_preference_persists(self):
        core = Core(self.settings)
        with patch.object(core, 'app_call') as app:
            self.assertEqual(core.hide(), 'close_requested')
            self.assertEqual([call.args for call in app.call_args_list], [('status',), ('do', 'window.close')])
        with patch.object(workers, 'load', return_value=(self.root, self.settings)):
            result = workers.operate(self.root, {'action': 'preference', 'mode': 'automatic'})
        self.assertEqual(result['view_preference'], 'automatic')
        self.assertEqual(workers.preference(self.root), 'automatic')


if __name__ == '__main__':
    unittest.main()
