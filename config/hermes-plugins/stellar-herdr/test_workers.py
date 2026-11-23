"""Tests for the Ivy worker admission and Herdr lifecycle boundary."""
from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from . import retained_view, workers
from .core import Core, Unavailable
from .retained_view import MOD


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
        git = shutil.which('git')
        self.assertIsNotNone(git, 'Git is required to verify real branch admission.')
        self.settings['git'] = git
        subprocess.run(
            [git, 'init', '--initial-branch=issue/23-fix'], cwd=self.cwd, check=True,
            capture_output=True,
        )
        subprocess.run(
            [git, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
             '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Fixture'],
            cwd=self.cwd, check=True, capture_output=True,
        )
        core = Mock()
        core.terminals.return_value = []
        core.launch.return_value = 't42'
        with patch.object(workers, 'command', side_effect=[self.claim, self.issue] * 2):
            self.assertEqual(self.submit(core)['terminal'], 't42')
            with self.assertRaisesRegex(Unavailable, 'already has a launch receipt'):
                self.submit(core)
        core.launch.assert_called_once()
        issue, role, cwd, argv = core.launch.call_args.args
        self.assertEqual((issue, role, cwd), (23, 'peon-cloud', self.cwd.resolve()))
        incarnation = core.launch.call_args.kwargs['incarnation']
        self.assertRegex(incarnation, r'^[0-9a-f]{32}$')
        receipt = json.loads(next((self.root / 'attempts').glob('*/terminal.json')).read_text())
        self.assertEqual(receipt['incarnation'], incarnation)
        self.assertEqual(receipt['claim_session'], 'job-23')
        self.assertEqual(receipt['branch'], 'issue/23-fix')
        self.assertEqual(argv[:4], ['fixture', '-p', 'peon-cloud', 'chat'])
        task_file = argv[argv.index('--query-file') + 1]
        self.assertIn('Check affected lint.', task_file.read_text(encoding='utf-8'))
        head = subprocess.check_output([git, 'rev-parse', 'HEAD'], cwd=self.cwd, text=True).strip()
        self.assertIn(f'Baseline: {head}', task_file.read_text(encoding='utf-8'))
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

    def test_requested_issue_falls_back_when_the_listed_live_terminal_disappears(self):
        configured = self.root / f'{MOD}.json'
        selected = self.root / f'{MOD}-request.json'
        self.settings['overview_snapshot'] = str(configured)
        configured.write_text('existing complete snapshot', encoding='utf-8')
        core = Mock()
        live = {'issue': 23, 'terminal': 't2', 'state': 'live'}
        core.terminals.return_value = [live]
        core.focus.side_effect = Unavailable('The listed terminal has ended.')
        visible = []

        def app(*args):
            if args == ('status',):
                return {'overlays': list(visible)}
            self.assertEqual(args, ('do', 'mod.open', '--name', MOD))
            visible.append(MOD)
            request = json.loads(selected.read_text(encoding='utf-8'))
            self.assertEqual(request['issue'], 23)
            self.assertEqual(request['phase'], 'opening')
            return {'ok': True}

        def acknowledge(path):
            request = json.loads(path.read_text(encoding='utf-8'))
            self.assertEqual(request['phase'], 'ready')
            rendered = {**request, 'overlay': 'exact-instance', 'loadedAt': request['createdAt']}
            path.write_text(json.dumps(rendered), encoding='utf-8')
            return rendered

        core.app_call.side_effect = app
        data = {'workers': [{'issue': 23, 'process': 'unavailable', 'task': 'private'}],
                'coverage': 'Confirmed attempts', 'generated_at': 10, 'warnings': []}
        with (patch.object(workers, 'load', return_value=(self.root, self.settings)),
              patch.object(workers, 'Core', return_value=core),
              patch.object(retained_view, '_read_request', side_effect=acknowledge),
              patch.object(retained_view, 'snapshot', return_value=data) as snapshot):
            value = workers.operate(self.root, {'action': 'show', 'issue': 23})
        snapshot.assert_called_once_with(self.root, core, issue=23)
        self.assertEqual(configured.read_text(encoding='utf-8'), 'existing complete snapshot')
        record = json.loads(selected.read_text(encoding='utf-8'))
        self.assertEqual(value, {'view': 'rendered', 'issue': 23, 'worker_view': 'retained-overview',
                                 'request_id': record['id'], 'overlay_id': 'exact-instance',
                                 'rendered_at': record['loadedAt'], 'retained_attempts': 1})
        self.assertEqual(record['snapshot']['workers'], [{'issue': 23, 'process': 'unavailable'}])
        core.focus.assert_called_once_with(live)

    def test_requested_focus_uses_exact_live_issue_before_retained_fallback(self):
        core = Mock()
        row = {'issue': 23, 'terminal': 't2', 'state': 'live'}
        core.terminals.return_value = [{'issue': 99, 'terminal': 't3', 'state': 'live'}, row]
        core.focus.return_value = 'focused'
        with (patch.object(workers, 'load', return_value=(self.root, self.settings)),
              patch.object(workers, 'Core', return_value=core)):
            result = workers.operate(self.root, {'action': 'focus', 'issue': 23})
        self.assertEqual(result, {'view': 'open', 'issue': 23, 'worker_view': 'focused'})
        core.focus.assert_called_once_with(row)
        core.app_call.assert_not_called()

    def test_focus_uses_existing_layout_terminal_before_attaching_a_tab(self):
        core = Core(self.settings)
        worker = {'issue': 23, 'terminal': 't2', 'state': 'live'}
        with (patch.object(core, 'detail', return_value=worker),
              patch.object(core, 'app_call', side_effect=[{'spaces': []}, {'ok': True}]) as app):
            self.assertEqual(core.focus(worker, open_window=False), 'focused')
        self.assertEqual([call.args for call in app.call_args_list],
                         [('ls',), ('do', 'pane.focus', '--terminal', 't2')])

    def test_retained_view_refuses_unrelated_overlay_or_missing_confirmation(self):
        self.settings['overview_snapshot'] = str(self.root / f'{MOD}.json')
        core = Mock()
        core.terminals.return_value = []
        data = {'workers': [{'issue': 23}], 'coverage': 'Confirmed attempts',
                'generated_at': 10, 'warnings': []}
        with (patch.object(workers, 'load', return_value=(self.root, self.settings)),
              patch.object(workers, 'Core', return_value=core),
              patch.object(retained_view, 'snapshot', return_value=data),
              patch.object(retained_view.time, 'monotonic', side_effect=[0, 8])):
            core.app_call.return_value = {'overlays': ['unrelated-dialog']}
            with self.assertRaisesRegex(Unavailable, 'other Herdr overlay'):
                workers.operate(self.root, {'action': 'focus', 'issue': 23})
            self.assertFalse((self.root / f'{MOD}-request.json').exists())
            core.app_call.side_effect = [
                {'overlays': []}, {'ok': True}, {'overlays': [MOD]}, {'ok': True},
            ]
            with self.assertRaisesRegex(Unavailable, 'did not confirm'):
                workers.operate(self.root, {'action': 'focus', 'issue': 23})
            self.assertTrue(all('overlay.close' not in call.args
                                for call in core.app_call.call_args_list))

    def test_render_receipt_must_match_the_exact_unexpired_request(self):
        request = {'id': 'exact', 'createdAt': 10, 'expiresAt': 18, 'issue': 23}
        receipt = {**request, 'overlay': 'view-a', 'loadedAt': 14}
        self.assertTrue(retained_view._loaded(request, receipt))
        for change in ({'id': 'another'}, {'issue': 24}, {'loadedAt': 19},
                       {'loadedAt': 9}, {'overlay': ''}, {'closed': True}):
            self.assertFalse(retained_view._loaded(request, {**receipt, **change}))


if __name__ == '__main__':
    unittest.main()
