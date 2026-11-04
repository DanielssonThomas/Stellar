import asyncio
import importlib.util
import hashlib
import json
from pathlib import Path
import socket
import queue
import sys
import unittest
from unittest.mock import patch

import httpx2
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
import uvicorn

ROOT = Path(__file__).resolve().parents[2] / 'apps/stellar-desktop/src-tauri/src/ivy'


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


protocol = load('workspace_protocol')
mcp = load('workspace_mcp')
service = load('workspace_service')
credentials = load('workspace_credentials')
bridge = load('ivy_bridge')
sys.modules['stellar_ivy_controls'] = load('ivy_controls')


class MemoryCredentials:
    CRED_TYPE_GENERIC = 1
    CRED_PERSIST_LOCAL_MACHINE = 2

    def __init__(self):
        self.values = {}

    def CredWrite(self, value, flags):
        self.values[value['TargetName']] = value

    def CredRead(self, name, kind, flags):
        item = self.values[name]
        return {**item, 'CredentialBlob': item['CredentialBlob'].encode('utf-16-le')}


class WorkspaceServiceTests(unittest.IsolatedAsyncioTestCase):
    async def test_bridge_relays_real_mcp_tool_before_admission_reply(self):
        class Pipe:
            def __init__(self): self.buffer = self; self.lines = queue.Queue()
            def readline(self, limit): return self.lines.get(timeout=5)
            def send(self, value): self.lines.put(json.dumps(value).encode() + b'\n')
        pipe = Pipe()
        frames = []
        def emit(frame):
            frames.append(frame)
            if frame.get('event') == 'workspace_tool':
                data = frame['data']
                reply = {key: data[key] for key in ('version', 'request_id', 'epoch', 'turn_id')}
                pipe.send({'control': 'workspace_reply', 'reply': {**reply, 'outcome': {'kind': 'applied'}}})
            elif frame.get('id') == 1:
                pipe.lines.put(b'')
        gate = protocol.WorkspaceGate(emit)
        instance = service.WorkspaceService(credentials.WorkspaceCredentials(MemoryCredentials()), gate, mcp.make_server)
        setup = await instance.start()
        descriptor = setup['descriptor']
        instance.bind_session('owned')
        class Client:
            completed = set()
            async def call(self, method, params):
                token = gate.active[2]
                assert token in params['text']
                headers = {'Authorization': 'Bearer ' + instance.bearer}
                async with httpx2.AsyncClient(headers=headers, trust_env=False) as http:
                    async with streamable_http_client(f"http://127.0.0.1:{descriptor['port']}/mcp", http_client=http) as streams:
                        async with ClientSession(streams[0], streams[1]) as session:
                            await session.initialize()
                            result = await session.call_tool('clear_panes', {'turn_token': token})
                            assert not result.is_error
                return {'ref': {'session_id': 'owned'}, 'admission_id': 'admission'}
        pipe.send({'id': 1, 'method': 'prompt.submit', 'params': {'session_id': 'owned',
            'input_id': '00000000-0000-4000-8000-000000000001', 'workspace_epoch': '5', 'text': 'hello'}})
        try:
            with patch.object(sys, 'stdin', pipe), patch.object(bridge, 'emit', emit):
                await asyncio.wait_for(bridge.requests_with_workspace(Client(), instance), 5)
            self.assertEqual(frames[0]['event'], 'workspace_tool')
            self.assertEqual(frames[-1]['id'], 1)
            self.assertNotIn(instance.tokens[0], str(frames))
        finally:
            await instance.stop()

    async def test_restart_reattaches_exact_descriptor_and_refuses_occupied_port(self):
        store = credentials.WorkspaceCredentials(MemoryCredentials())
        first = service.WorkspaceService(store, protocol.WorkspaceGate(lambda _: None), mcp.make_server)
        frames = []
        second = service.WorkspaceService(store, protocol.WorkspaceGate(frames.append), mcp.make_server)
        first_setup = await first.start()
        descriptor = first_setup['descriptor']
        editor = first.editor()
        fingerprint = hashlib.sha256(json.dumps(editor['mcp_servers'], sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        info = {'source': 'acp', 'edit_approval_policy': 'ask', 'launch_request': {'editor': {'mcp_servers': {'fingerprint': fingerprint}}}}
        self.assertTrue(first.verifies(info))
        self.assertFalse(first.verifies({**info, 'source': 'cli'}))
        self.assertFalse(first.verifies({**info, 'edit_approval_policy': 'session'}))
        self.assertFalse(first.verifies({**info, 'launch_request': {'editor': {'mcp_servers': {'fingerprint': '0' * 64}}}}))
        old_token = first.gate.arm('1', 'old-turn')
        bearer = editor['mcp_servers'][0]['headers'][0]['value']
        self.assertNotIn(bearer, str(descriptor))
        with self.assertRaises(service.WorkspaceUnavailable):
            await second.start(descriptor)
        await first.stop()
        second_setup = await second.start(descriptor)
        self.assertEqual(second_setup['descriptor'], descriptor)
        self.assertNotEqual(second_setup['image_secret'], first_setup['image_secret'])
        self.assertEqual(second.editor(), editor)
        new_token = second.gate.arm('2', 'new-turn')
        with self.assertRaises(protocol.WorkspaceRefused):
            await second.gate.call({'kind': 'clear'}, old_token)
        self.assertNotEqual(old_token, new_token)
        pending = asyncio.create_task(second.gate.call({'kind': 'clear'}, new_token))
        await asyncio.sleep(0)
        request = frames[0]['data']
        reply = {key: request[key] for key in ('version', 'request_id', 'epoch', 'turn_id')}
        second.gate.reply({**reply, 'outcome': {'kind': 'applied'}})
        self.assertEqual(await pending, {'kind': 'applied'})
        await second.stop()

    async def test_private_image_stream_authenticates_and_does_not_block_control(self):
        frames = []
        gate = protocol.WorkspaceGate(frames.append)
        instance = service.WorkspaceService(credentials.WorkspaceCredentials(MemoryCredentials()), gate, mcp.make_server)
        setup = await instance.start()
        token = gate.arm('1', 'turn-one')
        pending = asyncio.create_task(gate.call({'kind': 'capture_window'}, token))
        await asyncio.sleep(0)
        request = frames[0]['data']
        header = {key: request[key] for key in ('version', 'request_id', 'epoch', 'turn_id')}
        async def send(secret, image):
            reader, writer = await asyncio.open_connection('127.0.0.1', setup['image_port'])
            writer.write(json.dumps({'secret': secret, 'header': header, 'size': len(image)}).encode() + b'\n' + image)
            await writer.drain()
            result = await asyncio.wait_for(reader.read(1), 3)
            writer.close()
            await writer.wait_closed()
            return result
        image = b'\x89PNG\r\n\x1a\n' + b'x' * 1100000
        self.assertEqual(await send('wrong', image[:8]), b'')
        self.assertFalse(pending.done())
        self.assertEqual(await send(setup['image_secret'], image), b'\x01')
        self.assertEqual(await pending, image)
        await instance.stop()

    async def test_restart_rejects_old_turn_and_reuses_session_for_new_turn(self):
        store = credentials.WorkspaceCredentials(MemoryCredentials())
        old_frames = []
        old_gate = protocol.WorkspaceGate(old_frames.append)
        first = service.WorkspaceService(store, old_gate, mcp.make_server)
        setup = await first.start()
        first.bind_session('owned')
        old_token = old_gate.arm('1', 'first')
        pending = asyncio.create_task(old_gate.call({'kind': 'clear'}, old_token))
        await asyncio.sleep(0)
        old_gate.disarm()
        with self.assertRaises(protocol.WorkspaceRefused):
            await pending
        await first.stop()
        frames = []
        gate = protocol.WorkspaceGate(frames.append)
        second = service.WorkspaceService(store, gate, mcp.make_server)
        restored = await second.start(setup['descriptor'])
        self.assertEqual(restored['descriptor'], setup['descriptor'])
        second.bind_session('owned')
        token = gate.arm('2', 'second')
        with self.assertRaises(protocol.WorkspaceRefused):
            await gate.call({'kind': 'clear'}, old_token)
        task = asyncio.create_task(gate.call({'kind': 'clear'}, token))
        await asyncio.sleep(0)
        request = frames[0]['data']
        reply = {key: request[key] for key in ('version', 'request_id', 'epoch', 'turn_id')}
        gate.reply({**reply, 'outcome': {'kind': 'applied'}})
        self.assertEqual(await task, {'kind': 'applied'})
        await second.stop()

    async def test_resume_descriptor_is_injected_only_for_owned_session(self):
        store = credentials.WorkspaceCredentials(MemoryCredentials())
        instance = service.WorkspaceService(store, protocol.WorkspaceGate(lambda _: None), mcp.make_server)
        await instance.start()
        instance.bind_session('owned')
        class Client:
            def __init__(self): self.calls = []
            async def rpc(self, method, **params):
                self.calls.append((method, params))
                return {}
        client = Client()
        scoped = instance.wrap_client(client)
        await scoped.rpc('session.resume', session_id='owned')
        await scoped.rpc('session.resume', session_id='other')
        self.assertEqual(client.calls[0][1]['editor']['mcp_servers'], instance.editor()['mcp_servers'])
        self.assertNotIn('editor', client.calls[1][1])
        await instance.stop()

    async def test_missing_credential_ref_never_allocates_a_replacement(self):
        store = credentials.WorkspaceCredentials(MemoryCredentials())
        instance = service.WorkspaceService(store, protocol.WorkspaceGate(lambda _: None), mcp.make_server)
        with self.assertRaises(credentials.CredentialUnavailable):
            await instance.start({'port': 12345, 'credential_ref': '0' * 32})
        self.assertIsNone(instance.task)


class WorkspaceMcpTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.socket.bind(('127.0.0.1', 0))
        self.socket.listen(16)
        self.port = self.socket.getsockname()[1]
        self.url = f'http://127.0.0.1:{self.port}/mcp'
        self.bearer = 'test-bearer-' + 'x' * 40
        self.frames = []
        self.gate = protocol.WorkspaceGate(self.frames.append)
        self.mcp, app = mcp.make_server(self.gate, self.bearer, self.port)
        config = uvicorn.Config(app, log_config=None, access_log=False, proxy_headers=False,
                                lifespan='on', ws='none')
        self.server = uvicorn.Server(config)
        self.task = asyncio.create_task(self.server.serve(sockets=[self.socket]))
        for _ in range(200):
            if self.server.started:
                break
            if self.task.done():
                await self.task
                raise AssertionError('MCP server exited before startup')
            await asyncio.sleep(.01)
        self.assertTrue(self.server.started)

    async def asyncTearDown(self):
        self.gate.disarm()
        self.server.should_exit = True
        await asyncio.wait_for(self.task, 5)
        self.socket.close()

    async def test_rejects_bad_authority_origin_and_bearer(self):
        async with httpx2.AsyncClient(trust_env=False) as client:
            for headers in ({}, {'Authorization': 'Bearer wrong'},
                            {'Authorization': 'Bearer ' + self.bearer, 'Host': 'evil.example'},
                            {'Authorization': 'Bearer ' + self.bearer, 'Origin': 'http://evil.example'}):
                with self.subTest(headers=headers):
                    result = await client.post(self.url, headers=headers, json={})
                    self.assertEqual(result.status_code, 403)

    async def test_real_mcp_client_gets_tools_and_correlated_result(self):
        token = self.gate.arm('1', 'turn-one')
        headers = {'Authorization': 'Bearer ' + self.bearer}
        async with httpx2.AsyncClient(headers=headers, trust_env=False) as http:
            async with streamable_http_client(self.url, http_client=http) as streams:
                async with ClientSession(streams[0], streams[1]) as session:
                    await session.initialize()
                    tools = (await session.list_tools()).tools
                    names = {tool.name for tool in tools}
                    self.assertIn('conversing inside Stellar Desktop', next(t.description for t in tools if t.name == 'open_pane'))
                    self.assertIn('expected_revision', next(t.description for t in tools if t.name == 'open_pane'))
                    self.assertEqual(names, {'open_pane', 'update_pane', 'remove_pane', 'focus_pane',
                                             'arrange_panes', 'clear_panes', 'inspect_panes', 'capture_window', 'capture_display', 'capture_foreground', 'list_displays',
                                             'minimize_pane', 'restore_pane', 'maximize_pane', 'resize_pane', 'swap_panes', 'restore_layout', 'inspect_content'})
                    task = asyncio.create_task(session.call_tool('clear_panes', {'turn_token': token}))
                    for _ in range(200):
                        if self.frames:
                            break
                        await asyncio.sleep(.01)
                    self.assertEqual(len(self.frames), 1)
                    request = self.frames[0]['data']
                    self.assertNotIn(token, str(request))
                    reply = {key: request[key] for key in ('version', 'request_id', 'epoch', 'turn_id')}
                    self.gate.reply({**reply, 'outcome': {'kind': 'applied'}})
                    result = await asyncio.wait_for(task, 5)
                    self.assertFalse(result.is_error)
                    self.assertEqual(json.loads(result.content[0].text), {'kind': 'applied'})

    async def test_large_private_capture_result_reaches_real_mcp_client(self):
        token = self.gate.arm('1', 'turn-one')
        async with httpx2.AsyncClient(headers={'Authorization': 'Bearer ' + self.bearer}, trust_env=False) as http:
            async with streamable_http_client(self.url, http_client=http) as streams:
                async with ClientSession(streams[0], streams[1]) as session:
                    await session.initialize()
                    for tool in ['capture_window', 'capture_display', 'capture_foreground']:
                        self.frames.clear()
                        task = asyncio.create_task(session.call_tool(tool, {'turn_token': token}))
                        for _ in range(200):
                            if self.frames:
                                break
                            await asyncio.sleep(.01)
                        request = self.frames[0]['data']
                        self.assertEqual(request['operation']['kind'], tool)
                        header = {key: request[key] for key in ('version', 'request_id', 'epoch', 'turn_id')}
                        self.gate.reply_image(header, b'\x89PNG\r\n\x1a\n' + b'x' * 1100000)
                        result = await asyncio.wait_for(task, 5)
                        self.assertFalse(result.is_error)
                        self.assertEqual(result.content[0].type, 'image')
                        self.assertGreater(len(result.content[0].data), 1048576)

    async def test_all_registered_pane_tools_relay_validated_operations(self):
        token = self.gate.arm('1', 'turn-one')
        calls = [
            ('open_pane', {'instance_id': 'pane', 'surface': 'rich-text', 'payload_json': '{"text":"hello"}', 'prominence': 'primary'}, 'open'),
            ('update_pane', {'instance_id': 'pane', 'surface': 'rich-text', 'payload_json': '{"text":"updated"}'}, 'update'),
            ('focus_pane', {'instance_id': 'pane'}, 'focus'),
            ('minimize_pane', {'instance_id': 'pane'}, 'minimize'),
            ('restore_pane', {'instance_id': 'pane'}, 'restore'),
            ('maximize_pane', {'instance_id': 'pane'}, 'maximize'),
            ('resize_pane', {'instance_id': 'pane', 'percent': 65}, 'resize'),
            ('swap_panes', {'instance_id': 'pane', 'other_id': 'other'}, 'swap'),
            ('restore_layout', {}, 'restore_layout'),
            ('inspect_content', {'instance_id': 'pane'}, 'inspect_content'),
            ('arrange_panes', {'instance_ids': ['pane']}, 'arrange'),
            ('inspect_panes', {}, 'inspect'),
            ('remove_pane', {'instance_id': 'pane'}, 'remove'),
            ('clear_panes', {}, 'clear'),
        ]
        async with httpx2.AsyncClient(headers={'Authorization': 'Bearer ' + self.bearer}, trust_env=False) as http:
            async with streamable_http_client(self.url, http_client=http) as streams:
                async with ClientSession(streams[0], streams[1]) as session:
                    await session.initialize()
                    for name, args, expected in calls:
                        task = asyncio.create_task(session.call_tool(name, {**args, 'turn_token': token}))
                        for _ in range(200):
                            if self.frames:
                                break
                            await asyncio.sleep(.01)
                        request = self.frames.pop(0)['data']
                        self.assertEqual(request['operation']['kind'], expected)
                        reply = {key: request[key] for key in ('version', 'request_id', 'epoch', 'turn_id')}
                        outcome = {'kind': 'inspection', 'panes': []} if expected == 'inspect' else {'kind': 'content','instance_id': 'pane','surface':'rich-text','revision':2,'payload_json':'{}'} if expected == 'inspect_content' else {'kind': 'applied'}
                        self.gate.reply({**reply, 'outcome': outcome})
                        result = await asyncio.wait_for(task, 5)
                        self.assertFalse(result.is_error)
                        self.assertEqual(json.loads(result.content[0].text), outcome)


if __name__ == '__main__':
    unittest.main()
