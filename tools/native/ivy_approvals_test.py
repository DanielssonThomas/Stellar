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
