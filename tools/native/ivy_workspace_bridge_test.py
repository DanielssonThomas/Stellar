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
profile_tools = load('ivy_profile_tools')
sys.modules['stellar_ivy_profile_tools'] = profile_tools
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


class ProfileToolTests(unittest.TestCase):
    def test_desktop_selection_is_resolved_with_global_restrictions(self):
        config = {'platform_toolsets': {'desktop': ['hermes-cli', 'computer_use'], 'cli': ['file']},
                  'agent': {'disabled_toolsets': ['terminal']}}
        calls = []
        def resolve(value, platform):
            calls.append((value, platform))
            return {'file', 'computer_use', 'desktop_ui'}
        self.assertEqual(profile_tools.select_toolsets(config, resolve), ['computer_use', 'file'])
        self.assertEqual(calls, [(config, 'desktop')])

    def test_missing_desktop_uses_cli_and_empty_desktop_is_authoritative(self):
        for platforms, expected in [({'cli': ['file']}, 'cli'), ({'desktop': []}, 'desktop'), ({}, 'cli')]:
            calls = []
            def resolve(config, platform):
                calls.append(platform)
                return set()
            self.assertEqual(profile_tools.select_toolsets({'platform_toolsets': platforms}, resolve), [])
            self.assertEqual(calls, [expected])

    def test_malformed_selection_never_falls_back_to_broader_tools(self):
        for value in (None, 'all', {}, [None], [1], [''], ['file', 'file'], [' file'], ['file'] * 257):
            def resolve(*args):
                self.fail('Malformed selection reached resolver')
            with self.subTest(value=value), self.assertRaises(ValueError):
                profile_tools.select_toolsets({'platform_toolsets': {'desktop': value}}, resolve)
        for config in (None, [], {'platform_toolsets': None}, {'platform_toolsets': []}):
            with self.subTest(config=config), self.assertRaises(ValueError):
                profile_tools.select_toolsets(config, resolve)
        # Hermes marks unreadable/default-fallback configurations with a dict subclass.
        class FailedConfig(dict):
            pass
        with self.assertRaises(ValueError):
            profile_tools.select_toolsets(FailedConfig(), resolve)


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
                return {'session_create': {'parameters': ['model', 'provider', 'toolsets'], 'sources': ['acp']},
                        'capabilities': ['acp-editor-policy-v1', 'acp-session-mcp-v1']}
            async def rpc(self, method, **params):
                self.params = params
                return {'session_id': 'session', 'info': {'model': 'gpt-6.1-sol', 'source': 'acp', 'edit_approval_policy': 'ask',
                        'launch_request': {'model': 'gpt-6.1-sol', 'provider': 'openai-codex',
                                           'toolsets': params['toolsets']}}}

        conn, workspace = Connection(), Workspace()
        body = {'id': 1, 'method': 'session.create', 'params': {'request_id': 'request', 'model': 'gpt-6.1-sol'}}
        stdin = type('Input', (), {'buffer': io.BytesIO(json.dumps(body).encode() + b'\n')})()
        frames = []
        with patch.object(sys, 'stdin', stdin), patch.object(bridge, 'emit', frames.append), \
                patch.object(profile_tools, 'load_toolsets', return_value=['computer_use', 'file', 'terminal']):
            await bridge.requests_with_workspace(conn, workspace)
        self.assertEqual(conn.params['source'], 'acp')
        self.assertEqual(conn.params['editor'], workspace.editor())
        self.assertEqual(conn.params['toolsets'], ['computer_use', 'file', 'terminal'])
        self.assertEqual(set(conn.params), {'source', 'cwd', 'request_id', 'model', 'provider', 'editor', 'toolsets'})
        self.assertEqual(workspace.owner_session, 'session')
        self.assertEqual(frames, [{'id': 1, 'result': {'session_id': 'session', 'model': 'gpt-6.1-sol'}}])
        self.assertNotIn('private-secret', str(frames))

        # A gateway that ignores the explicit choice must never become a verified session.
        original_rpc = conn.rpc
        async def wrong_tools(method, **params):
            result = await original_rpc(method, **params)
            result['info']['launch_request']['toolsets'] = ['file']
            return result
        conn.rpc = wrong_tools
        stdin.buffer.seek(0)
        with patch.object(sys, 'stdin', stdin), patch.object(bridge, 'emit', frames.append), \
                patch.object(profile_tools, 'load_toolsets', return_value=['computer_use']):
            with self.assertRaises(bridge.Closed):
                await bridge.requests_with_workspace(conn, workspace)

        conn.params = None
        async def old_gateway(method, params):
            return {'session_create': {'parameters': ['model', 'provider'], 'sources': ['acp']},
                    'capabilities': ['acp-editor-policy-v1', 'acp-session-mcp-v1']}
        conn.call = old_gateway
        stdin.buffer.seek(0)
        with patch.object(sys, 'stdin', stdin), self.assertRaises(bridge.Closed):
            await bridge.requests_with_workspace(conn, workspace)
        self.assertIsNone(conn.params)

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



class ChartProtocolTests(unittest.TestCase):
    def chart(self, kind='line'):
        return {'type': kind, 'labels': ['Mon', 'Tue'], 'datasets': [{'label': 'Visits', 'values': [12, 18]}]}

    def operation(self, chart=None):
        return {'kind': 'open', 'instance_id': 'chart', 'surface': 'chart', 'prominence': 'primary',
                'payload_json': json.dumps({'title': 'Visits', 'chart': chart or self.chart()})}

    def test_chart_types_and_inline_blocks_use_the_real_operation_gate(self):
        for kind in ('line', 'bar', 'pie', 'doughnut'):
            value = self.operation(self.chart(kind))
            self.assertEqual(protocol.validate_operation(value), value)
        value = self.operation()
        value['surface'] = 'rich-text'
        value['payload_json'] = json.dumps({'title': 'Report', 'blocks': [
            {'kind': 'paragraph', 'text': 'Summary'}, {'kind': 'chart', 'chart': self.chart()}]})
        self.assertEqual(protocol.validate_operation(value), value)

    def test_chart_gate_rejects_unknown_options_and_inconsistent_values(self):
        for field in ('options', 'plugins', 'callbacks', 'onClick'):
            chart = {**self.chart(), field: {}}
            with self.assertRaises(protocol.WorkspaceRefused):
                protocol.validate_operation(self.operation(chart))
        for values in ([], [1], [1, 2, 3], [True, 2], [1e13, 2], [10**1000, 2], [float('inf'), 2]):
            chart = self.chart()
            chart['datasets'][0]['values'] = values
            with self.assertRaises(protocol.WorkspaceRefused):
                protocol.validate_operation(self.operation(chart))

    def test_circular_charts_and_axis_labels_are_bounded(self):
        for values in ([-1, 2], [0, 0]):
            chart = self.chart('pie')
            chart['datasets'][0]['values'] = values
            with self.assertRaises(protocol.WorkspaceRefused):
                protocol.validate_operation(self.operation(chart))
        for value in (None, '', 'x' * 121, '\u0085', '\ud800'):
            chart = {**self.chart(), 'x_label': value}
            with self.assertRaises(protocol.WorkspaceRefused):
                protocol.validate_operation(self.operation(chart))

    def test_inline_and_inspected_content_cannot_bypass_chart_validation(self):
        chart = {**self.chart(), 'options': {}}
        operation = self.operation(chart)
        operation['surface'] = 'rich-text'
        operation['payload_json'] = json.dumps({'title': 'Report', 'blocks': [{'kind': 'chart', 'chart': chart}]})
        with self.assertRaises(protocol.WorkspaceRefused):
            protocol.validate_operation(operation)
        with self.assertRaises(protocol.WorkspaceRefused):
            protocol.validate_outcome({'kind': 'content', 'instance_id': 'chart', 'surface': 'chart',
                                       'revision': 1, 'payload_json': self.operation(chart)['payload_json']}, 'inspect_content')


if __name__ == '__main__':
    unittest.main()
