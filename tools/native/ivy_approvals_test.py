import asyncio
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[2] / 'apps/stellar-desktop/src-tauri/src/ivy/ivy_approvals.py'
spec = importlib.util.spec_from_file_location('approvals', SOURCE)
approvals = importlib.util.module_from_spec(spec)
spec.loader.exec_module(approvals)
spec = importlib.util.spec_from_file_location('edit_policy', SOURCE.with_name('ivy_edit_policy.py'))
edit_policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(edit_policy)


class Client:
    def __init__(self):
        self.calls = []

    async def rpc(self, method, **params):
        self.calls.append((method, params))


def event(prompt='p', sid='s', generation=4, edit=True):
    payload = {'prompt_id': prompt, 'command': 'test command', 'description': 'test request'}
    if edit:
        payload['edit'] = {'tool_name': 'write_file', 'path': 'D:/outside-workspace/test.txt',
                           'old_text': None, 'new_text': 'fixture', 'arguments': {}}
    return {'session_id': sid, 'execution_generation': generation, 'payload': payload}


class AccessTests(unittest.IsolatedAsyncioTestCase):
    async def test_resume_defers_edit_consent_until_the_session_is_verified(self):
        for ready in (True, False):
            client = Client()
            selected = [None]
            handler = approvals.Approvals(client, lambda: selected[0], {'file_edits': 'all'})
            handler.begin_resume('s')
            handler.offer(event())
            await asyncio.sleep(0)
            self.assertFalse(client.calls)
            selected[0] = 's' if ready else None
            handler.finish_resume(ready)
            await self.settle(handler)
            self.assertEqual(client.calls[0][1]['choice'], 'once' if ready else 'deny')

    async def test_session_edit_grant_is_fenced_and_reads_back_before_background_work(self):
        for access, current, expected in (({'file_edits': 'all'}, 'ask', 'session'),
                                          ({}, 'session', 'ask')):
            snapshot = {'session_id': 's', 'revision': 7, 'execution_generation': 4,
                        'running': False, 'pending': [],
                        'info': {'source': 'acp', 'edit_approval_policy': current}}
            calls = []

            class PolicyClient:
                async def rpc(inner, method, **params):
                    calls.append((method, params))
                    if method == 'session.mutate':
                        snapshot['info']['edit_approval_policy'] = params['payload']['policy']
                        return {'session_id': 's', 'operation': 'edit_policy'}
                    return snapshot

            result = await edit_policy.synchronize(PolicyClient(), snapshot, access)
            self.assertEqual(result['info']['edit_approval_policy'], expected)
            self.assertEqual([method for method, _ in calls], ['session.mutate', 'session.resume'])
            params = calls[0][1]
            self.assertEqual((params['session_id'], params['expected_revision'], params['expected_generation']), ('s', 7, 4))
            self.assertEqual(params['operation'], 'edit_policy')
            self.assertEqual(params['payload'], {'policy': expected})
            calls.clear()
            await edit_policy.synchronize(PolicyClient(), snapshot, access)
            self.assertFalse(calls)

    async def test_edit_policy_never_changes_an_active_turn_or_unfenced_session(self):
        client = Client()
        base = {'session_id': 's', 'revision': 7, 'execution_generation': 4,
                'running': False, 'pending': [], 'info': {'source': 'acp', 'edit_approval_policy': 'ask'}}
        for state in ({'running': True}, {'pending': [{'admission_id': 'a'}]}):
            await edit_policy.synchronize(client, {**base, **state}, {'file_edits': 'all'})
        for state in ({'revision': True}, {'execution_generation': None}, {'running': None}):
            with self.assertRaises(ValueError):
                await edit_policy.synchronize(client, {**base, **state}, {'file_edits': 'all'})
        self.assertFalse(client.calls)

    async def test_wrong_policy_mutation_receipt_or_readback_is_refused(self):
        for wrong in ('receipt', 'policy'):
            snapshot = {'session_id': 's', 'revision': 7, 'execution_generation': 4,
                        'running': False, 'pending': [], 'info': {'source': 'acp', 'edit_approval_policy': 'ask'}}
            class WrongClient:
                async def rpc(inner, method, **params):
                    if method == 'session.mutate':
                        return {'session_id': 'foreign' if wrong == 'receipt' else 's', 'operation': 'edit_policy'}
                    return snapshot
            with self.assertRaises(ValueError):
                await edit_policy.synchronize(WrongClient(), snapshot, {'file_edits': 'all'})

    def test_missing_invalid_and_explicit_host_access(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            self.assertEqual(approvals.load_access(root), {})
            (root / 'integration').mkdir()
            path = root / 'integration/desktop-access.json'
            for value in ('{', 'null', '{}', '{"version":true,"file_edits":"all","interactive":true}',
                          '{"version":1,"file_edits":"ask","file_edits":"all","interactive":true}',
                          '{"version":1,"file_edits":"all","interactive":true,"extra":true}'):
                path.write_text(value, encoding='utf-8')
                self.assertEqual(approvals.load_access(root), {})
            expected = {'version': 1, 'file_edits': 'all', 'interactive': True}
            path.write_text(json.dumps(expected), encoding='utf-8')
            self.assertEqual(approvals.load_access(root), expected)

    async def settle(self, handler):
        await asyncio.gather(*handler.tasks.values())

    async def test_all_file_paths_need_opt_in_and_keep_exact_one_use_fence(self):
        for policy, choice in (({}, 'deny'), ({'file_edits': 'all'}, 'once')):
            client = Client()
            handler = approvals.Approvals(client, lambda: 's', policy)
            for i in range(8):
                handler.offer(event(str(i)))
                await self.settle(handler)
            handler.offer(event('7'))
            await self.settle(handler)
            self.assertEqual(len(client.calls), 8)
            self.assertEqual(client.calls[-1], ('approval.respond', {
                'session_id': 's', 'execution_generation': 4, 'prompt_id': '7', 'choice': choice}))

    async def test_commands_and_malformed_edits_never_use_file_grant(self):
        client = Client()
        handler = approvals.Approvals(client, lambda: 's', {'file_edits': 'all'})
        handler.offer(event(edit=False))
        malformed = event('bad')
        malformed['payload']['edit'] = {'path': 'test', 'new_text': 'x'}
        handler.offer(malformed)
        handler.offer(event('foreign', sid='other'))
        await self.settle(handler)
        self.assertEqual([p['choice'] for _, p in client.calls], ['deny'] * 3)

    async def test_native_answer_cannot_approve_changed_selection_or_unknown_choice(self):
        for answer in ('once', 'always'):
            client = Client()
            selected = ['s']

            async def consent(payload):
                if answer == 'once':
                    selected[0] = 'other'
                return answer

            handler = approvals.Approvals(client, lambda: selected[0], {'interactive': True}, consent)
            handler.offer(event(edit=False))
            await self.settle(handler)
            self.assertEqual(client.calls[0][1]['choice'], 'deny')

    async def test_command_once_and_dialog_cancellation_cleanup(self):
        client = Client()
        started, cancelled = asyncio.Event(), asyncio.Event()

        async def consent(payload):
            if payload['prompt_id'] == 'once':
                return 'once'
            started.set()
            try:
                await asyncio.Future()
            finally:
                cancelled.set()

        handler = approvals.Approvals(client, lambda: 's', {'interactive': True}, consent)
        handler.offer(event('once', edit=False))
        await self.settle(handler)
        handler.offer(event('pending', edit=False))
        await started.wait()
        await handler.cancel('s')
        self.assertTrue(cancelled.is_set())
        self.assertEqual(len(client.calls), 1)
        self.assertEqual(client.calls[0][1]['choice'], 'once')
        self.assertFalse(handler.tasks)

    async def test_settled_prompt_cancels_only_its_own_dialog(self):
        client = Client()
        started = asyncio.Event()

        async def consent(payload):
            started.set()
            await asyncio.Future()

        handler = approvals.Approvals(client, lambda: 's', {'interactive': True}, consent)
        handler.offer(event('pending', edit=False))
        await started.wait()
        await handler.settle({'session_id': 's', 'payload': {
            'execution_generation': 3, 'prompt_id': 'pending'}})
        self.assertFalse(handler.tasks[('s', 4, 'pending')].done())
        await handler.settle({'session_id': 's', 'payload': {
            'execution_generation': 4, 'prompt_id': 'pending'}})
        self.assertFalse(handler.tasks)
        self.assertFalse(client.calls)

    @unittest.skipUnless(os.name == 'nt', 'Native consent uses Windows PowerShell')
    async def test_dialog_request_is_data_and_cancel_reaps_the_process(self):
        class Process:
            returncode = None
            killed = False

            async def communicate(self, data):
                self.data = data
                self.returncode = 0
                return b'once', b''

            def kill(self):
                self.killed = True
                self.returncode = -1

            async def wait(self):
                return self.returncode

        process = Process()
        invocations = []

        async def spawn(*args, **kwargs):
            invocations.append(args)
            return process

        attack = '$(Write-Output NEVER_EXECUTE); `escape`'
        with patch.object(approvals.asyncio, 'create_subprocess_exec', spawn):
            self.assertEqual(await approvals.native_consent({'command': attack}), 'once')
        self.assertNotIn(attack, ' '.join(invocations[0]))
        self.assertIn(attack, json.loads(process.data)['text'])
        self.assertEqual(json.loads(process.data)['owner_pid'], os.getpid())

        async def cancelled(data):
            raise asyncio.CancelledError()

        process.returncode = None
        process.communicate = cancelled
        with patch.object(approvals.asyncio, 'create_subprocess_exec', spawn), self.assertRaises(asyncio.CancelledError):
            await approvals.native_consent({'command': 'fixture'})
        self.assertTrue(process.killed)

    async def test_bad_fences_are_refused_and_stale_rpc_is_not_retried(self):
        client = Client()

        async def stale(method, **params):
            client.calls.append((method, params))
            raise ValueError('stale generation')

        client.rpc = stale
        handler = approvals.Approvals(client, lambda: 's', {'file_edits': 'all'})
        with self.assertRaises(ValueError):
            handler.offer(event(generation=True))
        handler.offer(event())
        await self.settle(handler)
        self.assertEqual(len(client.calls), 1)


if __name__ == '__main__':
    unittest.main()
