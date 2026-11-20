"""Deterministic retained-view and supported focus regression fixtures."""
from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from .core import Core, Unavailable
from .outcomes import project
from .overview import receipts, render, snapshot, overview
from . import workers


def receipt(**changes):
    return {'schema': 1, 'launch': 'accepted', 'issue': 352, 'role': 'foreman-cloud',
            'terminal': 't3k', 'incarnation': 'a' * 32, 'baseline': 'b' * 40,
            'claim_session': 'claim-352', 'branch': 'issue/352-readable', 'target': 'develop',
            'runtime_session_id': 'runtime-352', 'launched_at': 900, **changes}


def metadata(**changes):
    return {'address': 't3k', 'labels': {'stellar-delegate': 'ivy', 'issue': '352',
            'role': 'foreman-cloud', 'stellar-launch': 'a' * 32}, 'state': 'live',
            'status': 'working', 'status_ms': 1000000, **changes}


class OutcomeTests(unittest.TestCase):
    def test_running_missing_stale_blocked_and_exit_zero_are_distinct(self):
        cases = [
            (metadata(), 'running', 'working', 'Process running'),
            (metadata(status=None), 'running', 'unavailable', 'status unavailable'),
            (metadata(status_ms=0), 'running', 'stale', 'stale'),
            (metadata(status='blocked'), 'running', 'blocked', 'blocked'),
            (metadata(state='finished', exit_code=0), 'exited', 'working', 'incomplete/unverified'),
            (None, 'unavailable', 'unavailable', 'Retained launch'),
        ]
        for row, process, status, summary in cases:
            with self.subTest(process=process, status=status):
                result = project(receipt(), row, now=1000)
                self.assertEqual((result['process'], result['status']), (process, status))
                self.assertIn(summary, result['summary'])
                for key in ('tests', 'review', 'merge'):
                    self.assertEqual(result[key], 'unverified')
                self.assertEqual(result['claim_session'], 'claim-352')
                self.assertEqual(result['runtime_session'], 'runtime-352')
                self.assertEqual(result['attempt'], 'a' * 32)

    def test_no_cross_incarnation_status_or_untrusted_output(self):
        bad = metadata(labels={**metadata()['labels'], 'stellar-launch': 'c' * 32},
                       text='PRIVATE REASONING', summary='<script>danger()</script>')
        self.assertEqual(project(receipt(), bad, now=1000)['process'], 'unavailable')
        for value in (True, None, float('nan'), float('inf'), 10**400, 1001000):
            self.assertEqual(project(receipt(), metadata(status_ms=value), now=1000)['status'], 'stale')
        result = project(receipt(task='PRIVATE REASONING'), metadata(), now=1000)
        self.assertNotIn('PRIVATE REASONING', json.dumps(result))
        self.assertEqual(project(receipt(), metadata(state='finished', exit_code=True), now=1000)['exit_code'], None)

    def test_blocked_exit_preserves_exit_zero_incomplete_summary(self):
        result = project(receipt(), metadata(state='finished', exit_code=0, status='blocked'), now=1000)
        self.assertIn('incomplete/unverified', result['summary'])
        self.assertIn('blocked', result['summary'])

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.directory = self.root / 'attempts' / ('352-' + hashlib.sha256(b'claim-352').hexdigest())
        self.directory.mkdir(parents=True)
        (self.directory / 'terminal.json').write_text(json.dumps(receipt()), encoding='utf-8')

    def test_registry_reconnect_retains_previous_incarnation_and_offline_launch(self):
        history = self.directory / ('resume-' + 'c' * 32)
        history.mkdir()
        previous = receipt(incarnation='c' * 32, terminal='t3j', launched_at=800)
        (history / 'previous-terminal.json').write_text(json.dumps(previous), encoding='utf-8')
        (history / 'terminal.json').write_text(json.dumps(receipt()), encoding='utf-8')
        core = Mock()
        core.call.side_effect = Unavailable('offline')
        first = snapshot(self.root, core, clock=lambda: 1000)
        self.assertEqual(len(first['workers']), 2)
        self.assertTrue(all(row['process'] == 'unavailable' for row in first['workers']))
        core.call.side_effect = lambda *args, **kwargs: metadata() if args[1] == 't3k' else None
        second = snapshot(self.root, core, clock=lambda: 1001)
        self.assertEqual(second['workers'][0]['process'], 'running')
        self.assertEqual(second['workers'][1]['process'], 'unavailable')
        self.assertIn('previous-terminal.json', second['workers'][1]['source'])
        self.assertEqual(core.call.call_args.args[0], 'get')
        self.assertEqual(core.call.call_count, 4)

    def test_oversize_invalid_and_ambiguous_receipts_do_not_erase_warnings(self):
        (self.directory / 'terminal.json').write_text('x' * 17000)
        rows, warnings = receipts(self.root)
        self.assertEqual(rows, [])
        self.assertTrue(warnings)
        page = render(snapshot(self.root, Mock(), clock=lambda: 1000))
        self.assertIn('not an all-clear', page)
        self.assertIn('omitted', page)

    def test_safe_html_output_and_action_use_no_transcript_or_launch(self):
        core = Mock()
        core.call.return_value = metadata(text='PRIVATE REASONING', summary='<script>evil()</script>')
        with patch.object(workers, 'load', return_value=(self.root, {})), patch.object(workers, 'Core', return_value=core):
            data = workers.operate(self.root, {'action': 'overview', 'issue': 352})
        page = Path(data['overview_file']).read_text(encoding='utf-8')
        self.assertNotIn('PRIVATE REASONING', page)
        self.assertNotIn('<script', page)
        self.assertIn('Internal Hermes helpers are not represented', page)
        self.assertIn('not native Herdr Agents', page)
        core.call.assert_called_once_with('get', 't3k', '--json', timeout=1)
        core.launch.assert_not_called()
        data['workers'][0]['summary'] = '<img src=x onerror=evil()>'
        self.assertIn('&lt;img', render(data))
        self.assertIn('default-src', page)

    def test_limit_is_explicit_and_filter_is_validated(self):
        for index in range(21):
            history = self.directory / f'resume-{index}'
            history.mkdir()
            row = receipt(incarnation=f'{index:032x}', launched_at=index)
            (history / 'terminal.json').write_text(json.dumps(row), encoding='utf-8')
        rows, warnings = receipts(self.root)
        self.assertEqual(len(rows), 20)
        self.assertTrue(any('20 most recent' in item for item in warnings))
        with self.assertRaises(Unavailable):
            snapshot(self.root, Mock(), issue=True)

    def test_focus_existing_pane_preserves_neighbors_without_attaching_or_writing(self):
        core = Core({'core': 'fixture', 'app': 'fixture'})
        spaces = {'spaces': [{'tabs': [{'terminals': [
            {'terminal': 't8', 'pane': 'neighbor'}, {'terminal': 't3k', 'pane': 'worker'},
        ]}]}]}
        with patch.object(core, 'detail', return_value={'terminal': 't3k', 'state': 'live'}), patch.object(core, 'show'), patch.object(core, 'app_call', return_value=spaces) as calls:
            self.assertEqual(core.focus({'terminal': 't3k'}), 'focused')
            self.assertEqual([call.args for call in calls.call_args_list], [('ls',), ('do', 'pane.focus', '--pane', 'worker')])


if __name__ == '__main__':
    unittest.main()
