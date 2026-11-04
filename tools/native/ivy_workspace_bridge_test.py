import asyncio
import importlib.util
import io
import json
from pathlib import Path
import queue
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2] / 'apps/stellar-desktop/src-tauri/src/ivy'


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


bridge = load('ivy_bridge')
sys.modules['stellar_ivy_activity'] = load('ivy_activity')
sys.modules['stellar_ivy_controls'] = load('ivy_controls')
sys.modules['stellar_ivy_edit_policy'] = load('ivy_edit_policy')
approvals_module = load('ivy_approvals')
protocol = load('workspace_protocol')


class Pipe:
    def __init__(self):
        self.buffer = self
        self.lines = queue.Queue()

    def readline(self, limit):
        return self.lines.get(timeout=5)

    def send(self, value):
        self.lines.put(json.dumps(value).encode() + b'\n')


class EarlyWorkspaceTests(unittest.IsolatedAsyncioTestCase):
    async def test_replayed_edit_during_resume_waits_for_verified_attachment(self):
        for verified in (True, False):
            replayed, reply = asyncio.Event(), asyncio.Event()
            class Workspace:
                task = object()
                def verifies(inner, info):
                    return verified
                def redact(inner, text):
                    return text
                gate = protocol.WorkspaceGate(lambda _: None)

            class Connection:
                def __init__(inner):
                    inner.client = inner
                    inner.events = asyncio.Queue()
                    inner.active = None
                    inner.completed = set()
                    inner.selected_session = 'old'
                    inner.answers = []
                async def call(inner, method, params):
                    if method == 'runtime.describe':
                        return {'capabilities': ['acp-session-mcp-v1']}
                    await inner.events.put({'params': {'type': 'approval.request', 'session_id': 's',
                        'execution_generation': 4, 'payload': {'prompt_id': 'p', 'edit': {
                            'tool_name': 'write_file', 'path': 'D:/fixture.txt', 'old_text': None,
                            'new_text': 'fixture', 'arguments': {}}}}})
                    replayed.set()
                    await reply.wait()
                    return {'session_id': 's', 'info': {'source': 'acp', 'edit_approval_policy': 'session'}}
                async def rpc(inner, method, **params):
                    inner.answers.append((method, params))

            conn = Connection()
            handler = approvals_module.Approvals(conn, lambda: conn.selected_session, {'file_edits': 'all'})
            incoming = asyncio.Queue()
            await incoming.put((1, 'session.resume', {'session_id': 's'}))
            await incoming.put(None)
            with patch.object(bridge, 'emit', lambda _: None):
                pump = asyncio.create_task(bridge.pump(conn, Workspace(), handler))
                worker = asyncio.create_task(bridge.request_worker(conn, Workspace(), incoming, handler))
                await replayed.wait()
                await asyncio.sleep(0)
                self.assertFalse(conn.answers)
                reply.set()
                if verified:
                    await worker
                else:
                    with self.assertRaises(bridge.Closed):
                        await worker
                await asyncio.gather(*handler.tasks.values())
                self.assertEqual(conn.answers, [('approval.respond', {
                    'session_id': 's', 'execution_generation': 4, 'prompt_id': 'p',
                    'choice': 'once' if verified else 'deny'})])
                await conn.events.put(RuntimeError('close fixture'))
                with self.assertRaises(bridge.Closed):
                    await pump

    async def test_acp_creation_checks_capabilities_and_keeps_descriptor_private(self):
        class Workspace:
            task = object()
            def editor(self):
                return {'mcp_servers': [{'type': 'http', 'name': 'stellar_workspace',
                                         'url': 'http://127.0.0.1:12345/mcp',
                                         'headers': [{'name': 'Authorization', 'value': 'Bearer private-secret'}]}],
                        'edit_approval_policy': 'ask'}
            def bind_session(self, sid):
                self.owner_session = sid
            def verifies(self, info):
                return info.get('source') == 'acp' and info.get('edit_approval_policy') == 'ask'
            gate = protocol.WorkspaceGate(lambda _: None)

        class Connection:
            def __init__(self):
                self.client = self
                self.sessions = set()
                self.params = None
            async def call(self, method, params):
                return {'session_create': {'parameters': ['model', 'provider'], 'sources': ['acp']},
                        'capabilities': ['acp-editor-policy-v1', 'acp-session-mcp-v1']}
            async def rpc(self, method, **params):
                self.params = params
                return {'session_id': 'session', 'info': {'model': 'gpt-6.1-sol', 'source': 'acp', 'edit_approval_policy': 'ask',
                        'launch_request': {'model': 'gpt-6.1-sol', 'provider': 'openai-codex'}}}

        conn, workspace = Connection(), Workspace()
        body = {'id': 1, 'method': 'session.create', 'params': {'request_id': 'request', 'model': 'gpt-6.1-sol'}}
        stdin = type('Input', (), {'buffer': io.BytesIO(json.dumps(body).encode() + b'\n')})()
        frames = []
        with patch.object(sys, 'stdin', stdin), patch.object(bridge, 'emit', frames.append):
            await bridge.requests_with_workspace(conn, workspace)
        self.assertEqual(conn.params['source'], 'acp')
        self.assertEqual(conn.params['editor'], workspace.editor())
        self.assertEqual(workspace.owner_session, 'session')
        self.assertEqual(frames, [{'id': 1, 'result': {'session_id': 'session', 'model': 'gpt-6.1-sol'}}])
        self.assertNotIn('private-secret', str(frames))

    async def test_reply_is_read_while_prompt_rpc_waits_for_early_tool(self):
        pipe = Pipe()
        frames = []
        gate = protocol.WorkspaceGate(lambda value: emit(value))
        class Workspace:
            task = object()
            owner_session = 's'
            def __init__(self):
                self.gate = gate
            def remember_token(self, token):
                self.token = token
        workspace = Workspace()

        def emit(value):
            frames.append(value)
            if value.get('event') == 'workspace_tool':
                request = value['data']
                reply = {key: request[key] for key in ('version', 'request_id', 'epoch', 'turn_id')}
                pipe.send({'control': 'workspace_reply', 'reply': {**reply, 'outcome': {'kind': 'applied'}}})
            elif value.get('id') == 7:
                pipe.lines.put(b'')

        class Connection:
            completed = set()
            async def call(self, method, params):
                self.assert_token = workspace.token in params['text']
                self.result = await gate.call({'kind': 'clear'}, workspace.token)
                return {'ref': {'session_id': 's'}, 'admission_id': 'a'}

        conn = Connection()
        pipe.send({'id': 7, 'method': 'prompt.submit', 'params': {
            'session_id': 's', 'input_id': '00000000-0000-4000-8000-000000000001', 'text': 'hello',
            'workspace_epoch': '1'}})
        with patch.object(sys, 'stdin', pipe), patch.object(bridge, 'emit', emit):
            await asyncio.wait_for(bridge.requests_with_workspace(conn, workspace), 3)
        self.assertEqual(conn.result, {'kind': 'applied'})
        self.assertTrue(conn.assert_token)
        self.assertNotIn(workspace.token, str(frames))
        self.assertEqual([frame.get('event') for frame in frames], ['workspace_tool', None])
        self.assertEqual(frames[-1]['id'], 7)



if __name__ == '__main__':
    unittest.main()
