"""Offline lifecycle tests using Herdr CLI and GitHub CLI response shapes."""
from __future__ import annotations

import hashlib
import io
import json
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import Mock, patch

from . import observation, observation_sources as sources
from .core import Core, Unavailable
from . import observer_tick
from .observation_store import FRESHNESS, LEASE, MAX_FAILURES, RETENTION, TRACKING_TTL, ObservationStore


def receipt():
    return {'schema': 1, 'launch': 'accepted', 'issue': 23, 'role': 'peon-cloud',
            'claim_session': 'job-23', 'branch': 'issue/23-fix', 'target': 'develop',
            'baseline': 'a' * 40, 'incarnation': 'b' * 32, 'terminal': 't42'}


def facts():
    return {'worker': {'state': 'live', 'exit_code': None, 'blocked': False},
            'github': {'pr': None, 'head': None, 'state': None, 'checks': 'unknown',
                       'verified': False, 'waiting_review': False}}


def connection(rows, has_next=False):
    return {'nodes': rows, 'pageInfo': {'hasNextPage': has_next}}


def response(issue, pulls):
    return {'data': {'repository': {'issue': {**issue, 'labels': connection(issue['labels'])},
                                    'pullRequests': connection(pulls)}}}


def pr(**changes):
    checks = changes.pop('statusCheckRollup', [
        {'__typename': 'CheckRun', 'status': 'COMPLETED', 'conclusion': 'SUCCESS'}])
    references = changes.pop('closingIssuesReferences', [
        {'number': 23, 'url': 'https://github.com/DanielssonThomas/Stellar/issues/23'}])
    return {'number': 24, 'headRefName': 'issue/23-fix', 'baseRefName': 'develop', 'isCrossRepository': False,
            'headRefOid': 'c' * 40, 'state': 'OPEN', 'isDraft': False, 'mergedAt': None,
            'commits': {'nodes': [{'commit': {'oid': changes.get('headRefOid', 'c' * 40),
                                             'statusCheckRollup': {'contexts': connection(checks)}}}]},
            'closingIssuesReferences': connection(references),
            **changes}


class SourcesTest(unittest.TestCase):
    def setUp(self):
        self.receipt = sources.validate_receipt(receipt())
        self.settings = {'gh': 'gh-fixture', 'node': 'node-fixture', 'repo': '.'}
        self.issue = {'state': 'OPEN', 'body': '- [ ] Deliver\n',
                      'labels': [{'name': label} for label in ('worker:peon-cloud', 'target:develop', 'status:review')]}

    def github(self, pulls, issue=None):
        with patch.object(sources, 'command', return_value=response(issue or self.issue, pulls)) as call:
            result = sources.github_fact(self.settings, self.receipt)
        for args in call.call_args_list:
            self.assertIn('query=' + sources.QUERY, args.args[0])
            self.assertIn('issue=23', args.args[0])
            self.assertIn('branch=issue/23-fix', args.args[0])
        return result

    def test_receipts_fail_closed_without_incarnation_and_provenance(self):
        for key in ('schema', 'launch', 'incarnation', 'baseline', 'claim_session', 'branch', 'target'):
            row = receipt()
            row.pop(key)
            with self.subTest(key=key), self.assertRaises(Unavailable):
                sources.validate_receipt(row)
        for key, value in [('issue', True), ('terminal', 't0'), ('role', 'codex'), ('branch', 'issue/24-foreign')]:
            with self.subTest(key=key), self.assertRaises(Unavailable):
                sources.validate_receipt({**receipt(), key: value})

    def test_worker_terminal_reuse_requires_exact_launch_label(self):
        core = Mock()
        row = {'state': 'finished', 'exit_code': 0, 'status': 'blocked',
               'labels': {'stellar-delegate': 'ivy', 'issue': '23', 'role': 'peon-cloud', 'stellar-launch': 'b' * 32}}
        core.call.return_value = row
        self.assertEqual(sources.worker_fact(core, self.receipt),
                         {'state': 'finished', 'exit_code': 0, 'blocked': True})
        core.call.assert_called_once_with('get', 't42', '--json')
        core.call.return_value = {**row, 'labels': {**row['labels'], 'stellar-launch': 'd' * 32}}
        with self.assertRaisesRegex(Unavailable, 'incarnation'):
            sources.worker_fact(core, self.receipt)

    def test_launcher_sets_incarnation_without_enabling_parent_notifications(self):
        core = Core({'core': 'fixture', 'app': 'fixture'})
        with patch.object(core, 'call', return_value={'address': 't42'}) as call:
            core.launch(23, 'peon-cloud', '.', ['hermes', 'chat'], incarnation='b' * 32)
        argv = call.call_args.args
        self.assertIn('stellar-launch=' + 'b' * 32, argv)
        self.assertIn('--no-notify', argv)
        self.assertIn('--no-parent', argv)

    def test_claim_change_and_expiry_suspend_but_exact_released_claim_is_valid(self):
        claim = {'issue': 23, 'worker': 'worker:peon-cloud', 'sessionId': 'job-23',
                 'branch': 'issue/23-fix', 'target': 'develop', 'state': 'active',
                 'expiresAt': '2099-01-01T00:00:00Z'}
        for change in ({}, {'state': 'released'}):
            with patch.object(sources, 'command', return_value={**claim, **change}):
                sources.check_claim(self.settings, self.receipt, 1000)
        for change in ({'worker': 'worker:foreman-cloud'}, {'sessionId': 'new-job'},
                       {'expiresAt': '1970-01-01T00:00:00Z'}, {'state': 'stale'}):
            with patch.object(sources, 'command', return_value={**claim, **change}), self.assertRaises(Unavailable):
                sources.check_claim(self.settings, self.receipt, 1000)

    def test_github_requires_exact_issue_link_branch_target_and_head(self):
        self.assertEqual(self.github([pr()])['head'], 'c' * 40)
        foreign = pr(closingIssuesReferences=[{'number': 23, 'url': 'https://github.com/other/repo/issues/23'}])
        self.assertIsNone(self.github([foreign])['pr'])
        for change in ({'baseRefName': 'main'}, {'headRefName': 'issue/24-other'}, {'headRefOid': 'bad'}, {'isCrossRepository': True}):
            with self.subTest(change=change), self.assertRaises(Unavailable):
                self.github([pr(**change)])
        for rows in ([pr(), pr(number=25)], [pr()] * 100):
            with self.assertRaises(Unavailable):
                self.github(rows)
        with self.assertRaisesRegex(Unavailable, 'ownership'):
            self.github([], {**self.issue, 'labels': [{'name': 'worker:foreman-cloud'}, {'name': 'target:develop'}]})

    def test_review_merge_and_verification_are_distinct_from_process_exit(self):
        self.assertTrue(self.github([pr()])['waiting_review'])
        self.assertFalse(self.github([pr(isDraft=True)])['waiting_review'])
        merged = pr(state='MERGED', mergedAt='2026-11-12T12:00:00Z')
        self.assertFalse(self.github([merged])['verified'])
        done = {**self.issue, 'state': 'CLOSED', 'body': '- [x] Deliver\n',
                'labels': [{'name': label} for label in ('worker:peon-cloud', 'target:develop', 'status:done')]}
        self.assertTrue(self.github([merged], done)['verified'])
        self.assertFalse(self.github([merged], {**done, 'body': '- [ ] Deliver\n'})['verified'])
        state = facts()
        state['worker'].update(state='finished', exit_code=0)
        self.assertEqual(sources.milestones(state), {'worker_exited': {'exit_code': 0}})

    def test_checks_never_infer_success_from_empty_partial_skipped_or_pending(self):
        self.assertEqual(sources.check_state([]), 'unknown')
        self.assertEqual(sources.check_state([{'state': 'SUCCESS'}]), 'unknown')
        self.assertEqual(sources.check_state([{'__typename': 'StatusContext', 'state': 'SUCCESS'}]), 'passed')
        self.assertEqual(sources.check_state([{'__typename': 'CheckRun', 'status': 'COMPLETED', 'conclusion': 'SKIPPED'}]), 'pending')
        self.assertEqual(sources.check_state([{'__typename': 'CheckRun', 'status': 'IN_PROGRESS'}]), 'pending')
        self.assertEqual(sources.check_state([{'__typename': 'StatusContext', 'state': 'FAILURE'}]), 'failed')
        row = pr()
        row['commits']['nodes'][0]['commit']['statusCheckRollup']['contexts']['pageInfo']['hasNextPage'] = True
        self.assertEqual(sources.pr_checks(row), 'unknown')
        row = pr()
        row['commits']['nodes'][0]['commit']['oid'] = 'd' * 40
        self.assertEqual(sources.pr_checks(row), 'unknown')

    def test_partial_github_pages_and_errors_fail_closed(self):
        for field in ('pullRequests', 'labels', 'closingIssuesReferences'):
            raw = response(self.issue, [pr()])
            repo = raw['data']['repository']
            target = repo['pullRequests'] if field == 'pullRequests' else (
                repo['issue']['labels'] if field == 'labels' else repo['pullRequests']['nodes'][0]['closingIssuesReferences'])
            target['pageInfo']['hasNextPage'] = True
            with patch.object(sources, 'command', return_value=raw), self.assertRaises(Unavailable):
                sources.github_fact(self.settings, self.receipt)
        with (patch.object(sources, 'command', return_value={**response(self.issue, []), 'errors': ['partial']}),
              self.assertRaises(Unavailable)):
            sources.github_fact(self.settings, self.receipt)

    def test_slow_or_unavailable_source_does_not_return_stale_facts(self):
        with (patch.object(sources, 'check_claim'), patch.object(sources, 'worker_fact', return_value=facts()['worker']),
              patch.object(sources, 'github_fact', return_value=facts()['github'])):
            with self.assertRaisesRegex(Unavailable, 'freshness'):
                sources.snapshot(self.settings, Mock(), self.receipt, clock=Mock(side_effect=[1000, 1061]))


class StoreTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.store = ObservationStore(self.root)
        self.receipt = sources.validate_receipt(receipt())
        self.now = 1000

    def enable(self, kinds=None, facts_=None):
        return self.store.enable(self.receipt, kinds or list(sources.KINDS), facts_ or facts(), self.now,
                                 self.store.consent_revision())

    def finished(self):
        result = facts()
        result['worker'].update(state='finished', exit_code=0)
        return result

    def poll(self, facts_):
        self.now += 61
        reservation = self.store.reserve(self.now)
        self.assertIsNotNone(reservation)
        self.store.finish(reservation, facts_, self.now)

    def events(self):
        return self.store.status(self.now)['transitions']

    def test_default_off_empty_and_baseline_silent(self):
        self.assertIsNone(self.store.reserve(self.now))
        self.assertEqual(self.events(), [])
        self.enable(facts_=self.finished())
        self.poll(self.finished())
        self.assertEqual(self.events(), [])

    def test_restart_duplicate_and_crash_replay_keep_stable_identity(self):
        self.enable()
        self.now += 61
        abandoned = self.store.reserve(self.now)
        self.assertIsNotNone(abandoned)
        self.assertIsNone(ObservationStore(self.root).reserve(self.now + 1))
        self.now += LEASE + 1
        recovered = ObservationStore(self.root).reserve(self.now)
        self.store.finish(recovered, self.finished(), self.now)
        self.store.finish(abandoned, self.finished(), self.now)
        first = self.events()
        self.assertEqual(len(first), 1)
        self.store = ObservationStore(self.root)
        self.poll(self.finished())
        self.assertEqual(first, self.events())
        self.assertEqual(first[0]['kind'], 'worker_exited')
        self.assertEqual(len(first[0]['identity']), 64)

    def test_optout_clears_pending_records_and_fences_inflight_fetch(self):
        self.enable()
        self.poll(self.finished())
        self.assertEqual(len(self.events()), 1)
        self.now += 61
        reserved = self.store.reserve(self.now)
        self.store.disable(23)
        self.store.finish(reserved, self.finished(), self.now)
        self.assertEqual(self.events(), [])
        self.assertIsNone(self.store.reserve(self.now + 999))
        self.enable(facts_=self.finished())
        self.poll(self.finished())
        self.assertEqual(self.events(), [])

    def test_disable_wins_over_slow_enable_and_concurrent_reenable(self):
        expected = self.store.consent_revision()
        self.store.disable(23)
        with self.assertRaisesRegex(Unavailable, 'Consent changed'):
            self.store.enable(self.receipt, list(sources.KINDS), facts(), self.now, expected)
        self.enable()
        self.now += 61
        old = self.store.reserve(self.now)
        self.enable(facts_=self.finished())
        self.store.finish(old, self.finished(), self.now)
        self.assertEqual(self.events(), [])

    def test_filters_outages_freshness_and_retry_exhaustion(self):
        self.enable(kinds=['worker_blocked'])
        self.poll(self.finished())
        self.assertEqual(self.events(), [])
        for index in range(MAX_FAILURES):
            self.now += 3601
            reserved = self.store.reserve(self.now)
            self.assertIsNotNone(reserved)
            self.store.finish(reserved, None, self.now)
            self.assertEqual(self.events(), [])
        status = self.store.status(self.now)['tracking'][0]
        self.assertEqual(status['health'], 'retry_exhausted')
        self.assertEqual(status['enabled'], 0)
        self.assertIsNone(self.store.reserve(self.now + 100000))

    def test_failure_preserves_baseline_and_recovery_records_transition_once(self):
        self.enable()
        self.poll(None)
        self.assertEqual(self.store.status(self.now)['tracking'][0]['health'], 'unavailable')
        self.poll(self.finished())
        self.assertEqual(len(self.events()), 1)
        self.now += FRESHNESS + 1
        self.assertEqual(self.events(), [])
        self.assertEqual(self.store.status(self.now)['tracking'][0]['health'], 'stale')
        self.assertEqual(self.store.status(0)['transitions'], [])

    def test_new_pr_head_has_independent_dedup_and_never_confers_authority(self):
        self.enable()
        current = facts()
        current['github'].update(pr=24, head='c' * 40, state='OPEN', waiting_review=True, checks='failed')
        self.poll(current)
        self.assertEqual({event['kind'] for event in self.events()}, {'checks_failed', 'waiting_review'})
        self.poll(current)
        self.assertEqual(len(self.events()), 2)
        current['github']['head'] = 'd' * 40
        self.poll(current)
        self.assertEqual(len(self.events()), 4)
        self.assertEqual(self.store.status(self.now)['delivery'], 'blocked_supported_session_bound_producer_required')
        for event in self.events():
            self.assertNotIn('admission_id', event)
            self.assertNotIn('session_id', event)

    def test_expiry_and_retention_are_bounded(self):
        self.enable()
        self.poll(self.finished())
        self.now += TRACKING_TTL
        self.assertIsNone(self.store.reserve(self.now))
        self.assertEqual(self.events(), [])
        self.now += RETENTION
        self.assertEqual(self.store.status(self.now)['tracking'], [])

    def test_enumeration_tick_is_bounded_and_reads_no_sources_when_disabled(self):
        with patch.object(observation, 'snapshot') as read:
            self.assertEqual(observation.reconcile(self.store, {}, Mock(), clock=lambda: self.now)['reconciled'], 0)
        read.assert_not_called()
        self.enable()
        self.now += 61
        with patch.object(observation, 'snapshot', side_effect=Unavailable('offline')) as read:
            self.assertEqual(observation.reconcile(self.store, {}, Mock(), clock=lambda: self.now)['reconciled'], 1)
        read.assert_called_once()
        self.assertEqual(self.store.status(self.now)['tracking'][0]['health'], 'unavailable')

    def test_tool_tracks_exact_receipt_and_silences_issue_without_receipt(self):
        path = self.root / 'attempts' / ('23-' + hashlib.sha256(b'job-23').hexdigest())
        path.mkdir(parents=True)
        (path / 'terminal.json').write_text(json.dumps(receipt()), encoding='utf-8')
        with patch.object(observation, 'snapshot', return_value=facts()):
            result = observation.operate_observation(self.root, {}, Mock(),
                {'action': 'tracking', 'issue': 23, 'role': 'peon-cloud', 'session_id': 'job-23', 'enabled': True})
        self.assertTrue(result['tracking'])
        observation.operate_observation(self.root, {}, Mock(), {'action': 'tracking', 'issue': 23, 'enabled': False})
        self.assertEqual(self.store.status(0)['tracking'][0]['enabled'], 0)
        with self.assertRaises(Unavailable):
            observation.receipt_for(self.root, 23, 'foreman-cloud', 'job-23')

    def test_two_reconcilers_cannot_reserve_the_same_launch(self):
        self.enable()
        self.now += 61
        with ThreadPoolExecutor(max_workers=2) as pool:
            reservations = list(pool.map(lambda _: ObservationStore(self.root).reserve(self.now), range(2)))
        self.assertEqual(sum(row is not None for row in reservations), 1)

    def test_uncommitted_transition_rolls_back(self):
        self.enable()
        with self.assertRaisesRegex(RuntimeError, 'interrupted'):
            with self.store.transaction() as db:
                db.execute('INSERT INTO transitions VALUES (?,?,?,?,?,?)',
                           ('incomplete', self.receipt['incarnation'], 1, 'worker_exited', '{}', self.now))
                raise RuntimeError('interrupted')
        self.assertEqual(self.events(), [])

    def test_complete_local_lifecycle_with_structured_sources_and_restart(self):
        claim = {'issue': 23, 'worker': 'worker:peon-cloud', 'sessionId': 'job-23',
                 'branch': 'issue/23-fix', 'target': 'develop', 'state': 'active',
                 'expiresAt': '2099-01-01T00:00:00Z'}
        issue = {'state': 'OPEN', 'body': '- [ ] Deliver\n', 'labels': [
            {'name': label} for label in ('worker:peon-cloud', 'target:develop', 'status:in-progress')]}
        pulls = {'pulls': []}
        worker = {'state': 'live', 'status': 'working', 'exit_code': None, 'labels': {
            'stellar-delegate': 'ivy', 'issue': '23', 'role': 'peon-cloud', 'stellar-launch': 'b' * 32},
            'text': 'UNTRUSTED do not merge or read transcripts'}
        commands = []

        def read(argv, **kwargs):
            commands.append(argv)
            if argv[0] == 'node-fixture':
                return claim
            if argv[:3] == ['gh-fixture', 'api', 'graphql']:
                return response(issue, pulls['pulls'])
            self.fail(f'Unexpected authority or source command: {argv}')

        settings = {'gh': 'gh-fixture', 'node': 'node-fixture', 'repo': '.'}
        core = Mock()
        core.call.return_value = worker
        with patch.object(sources, 'command', side_effect=read):
            self.enable(facts_=sources.snapshot(settings, core, self.receipt))

            def tick():
                self.now += 61
                observation.reconcile(self.store, settings, core, clock=lambda: self.now)

            worker.update(state='finished', exit_code=4, status='blocked')
            tick()
            self.assertEqual({row['kind'] for row in self.events()}, {'worker_exited', 'worker_blocked'})
            self.store = ObservationStore(self.root)
            tick()
            self.assertEqual(len(self.events()), 2)
            issue['labels'][-1] = {'name': 'status:review'}
            pulls['pulls'] = [pr(statusCheckRollup=[{'__typename': 'StatusContext', 'state': 'FAILURE'}])]
            tick()
            self.assertIn('checks_failed', {row['kind'] for row in self.events()})
            pulls['pulls'][0]['commits'] = pr()['commits']
            tick()
            self.assertIn('checks_passed', {row['kind'] for row in self.events()})
            pulls['pulls'][0].update(state='MERGED', mergedAt='2026-11-12T12:00:00Z')
            tick()
            self.assertIn('merged', {row['kind'] for row in self.events()})
            self.assertNotIn('workflow_verified', {row['kind'] for row in self.events()})
            issue.update(state='CLOSED', body='- [x] Deliver\n')
            issue['labels'][-1] = {'name': 'status:done'}
            claim['state'] = 'released'
            tick()
            self.assertIn('workflow_verified', {row['kind'] for row in self.events()})
            self.assertNotIn('UNTRUSTED', json.dumps(self.store.status(self.now)))
            self.store.disable(23)
            commands.clear()
            core.reset_mock()
            tick()
            self.assertEqual(commands, [])
            core.call.assert_not_called()
            self.assertEqual(self.events(), [])

    def test_no_agent_entry_point_is_silent_and_never_delivers_observations(self):
        profile = self.root / 'profile'
        root = profile / 'integration' / 'stellar-herdr'
        root.mkdir(parents=True)
        settings = {key: str(self.root / key) for key in ('repo', 'core', 'app', 'hermes', 'node', 'gh', 'git')}
        (root / 'settings.json').write_text(json.dumps(settings), encoding='utf-8')
        constants = Mock()
        constants.get_hermes_home.return_value = profile
        output = io.StringIO()
        with patch.dict(sys.modules, {'hermes_constants': constants}), redirect_stdout(output):
            self.assertEqual(observer_tick.main(), 0)
        self.assertEqual(json.loads(output.getvalue()), {'wakeAgent': False})
        self.assertEqual(ObservationStore(root).status(self.now)['tracking'], [])
        constants.get_hermes_home.side_effect = RuntimeError('private diagnostic content')
        output, error = io.StringIO(), io.StringIO()
        with (patch.dict(sys.modules, {'hermes_constants': constants}),
              redirect_stdout(output), redirect_stderr(error)):
            self.assertEqual(observer_tick.main(), 0)
        self.assertEqual(json.loads(output.getvalue()), {'wakeAgent': False})
        self.assertNotIn('private diagnostic', error.getvalue())

    def test_journal_capacity_pauses_without_forgetting_dedup_keys(self):
        self.enable(kinds=['checks_failed'])
        current = facts()
        current['github'].update(pr=24, state='OPEN', checks='failed')
        for index in range(101):
            current['github']['head'] = f'{index:040x}'
            self.poll(current)
        status = self.store.status(self.now)
        self.assertEqual(status['tracking'][0]['health'], 'journal_full')
        self.assertEqual(status['tracking'][0]['enabled'], 0)
        with self.store.transaction() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM transitions').fetchone()[0], 100)
        self.assertIsNone(self.store.reserve(self.now + 61))

    def test_one_tick_observes_at_most_four_launches(self):
        for index in range(5):
            row = {**self.receipt, 'issue': 23 + index, 'branch': f'issue/{23 + index}-fix', 'incarnation': f'{index:032x}'}
            self.store.enable(row, list(sources.KINDS), facts(), self.now, self.store.consent_revision())
        self.now += 61
        with patch.object(observation, 'snapshot', return_value=facts()) as read:
            self.assertEqual(observation.reconcile(self.store, {}, Mock(), clock=lambda: self.now)['reconciled'], 4)
            self.assertEqual(read.call_count, 4)
            self.assertEqual(observation.reconcile(self.store, {}, Mock(), clock=lambda: self.now)['reconciled'], 1)

    def test_invalid_filters_preserve_existing_consent(self):
        self.enable()
        for kinds in ([], ['worker_exited', 'worker_exited'], ['unknown'], [{}]):
            with self.assertRaises(Unavailable):
                self.store.enable(self.receipt, kinds, facts(), self.now, self.store.consent_revision())
        self.assertEqual(self.store.status(self.now)['tracking'][0]['revision'], 1)


if __name__ == '__main__':
    unittest.main()
