import asyncio
import importlib.util
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
SOURCE = Path(__file__).resolve().parents[2] / 'apps/stellar-desktop/src-tauri/src/ivy/ivy_bridge.py'
spec = importlib.util.spec_from_file_location('bridge', SOURCE)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class Pipe:
    def __init__(self, value=b''):
        self.buffer = io.BytesIO(value)


class Lease:
    def __init__(self):
        self.released = []

    def release(self, settled=False):
        self.released.append(settled)


class Connection:
    def __init__(self):
        self.calls = []
        self.client = self
        self.events = asyncio.Queue()
        self.completed = set()
        self.active = None
        self.lease = Lease()

    async def call(self, method, params):
        self.calls.append((method, params))
        if method == 'ping':
            return {'pong': True}
        if method == 'runtime.describe':
            return {'profile_id': str(bridge.PROFILE), 'capabilities': bridge.CAPABILITIES,
                    'skin': {'private': 'excluded'}, 'secret': 'excluded'}
        return {}

    async def rpc(self, method, **params):
        return await self.call(method, params)


class BridgeTests(unittest.IsolatedAsyncioTestCase):
    async def test_health_is_silent_and_projects_only_verified_values(self):
        conn = Connection()
        stdin = Pipe(b'{"id":1,"method":"ping","params":{}}\n{"id":2,"method":"runtime.describe","params":{}}\n')
        stdout = Pipe()
        with patch.object(sys, 'stdin', stdin), patch.object(sys, 'stdout', stdout):
            await bridge.requests(conn)
        self.assertEqual([method for method, _ in conn.calls], ['ping', 'runtime.describe'])
        frames = [json.loads(line) for line in stdout.buffer.getvalue().splitlines()]
        self.assertEqual(frames[0]['result'], {'pong': True})
        self.assertEqual(set(frames[1]['result']), {'profile', 'protocol', 'capabilities'})
        self.assertNotIn(b'excluded', stdout.buffer.getvalue())

    async def test_wrong_health_does_not_become_ready(self):
        conn = Connection()
        async def wrong(method, params):
            return {'pong': False}
        conn.call = wrong
        with patch.object(sys, 'stdin', Pipe(b'{"id":1,"method":"ping","params":{}}\n')), patch.object(sys, 'stdout', Pipe()):
            with self.assertRaises(bridge.Closed):
                await bridge.requests(conn)

    def test_exact_request_schema_and_size(self):
        for request in [
            {'id': True, 'method': 'ping', 'params': {}},
            {'id': 1, 'method': 'audio.synthesize', 'params': {'text': 'no'}},
            {'id': 1, 'method': 'session.create', 'params': {'request_id': 'id', 'profile': 'other'}},
            {'id': 1, 'method': 'prompt.submit', 'params': {'session_id': 'id', 'input_id': 'id', 'text': ' '}},
        ]:
            with self.assertRaises(ValueError):
                bridge.validate(request)
        with self.assertRaises(ValueError):
            json.loads('{"id":1,"id":2}', object_pairs_hook=bridge.pairs)
        with patch.object(sys, 'stdout', Pipe()), self.assertRaises(bridge.Closed):
            bridge.emit({'text': 'a' * bridge.OUTPUT_LIMIT})

    async def test_timeout_is_uncertain_and_does_not_retry(self):
        conn = Connection()
        async def delayed(method, params):
            conn.calls.append((method, params))
            await asyncio.sleep(10)
        conn.call = delayed
        stdout = Pipe()
        with patch.object(bridge, 'DEADLINE', 0.01), patch.object(sys, 'stdin', Pipe(b'{"id":1,"method":"ping","params":{}}\n')), patch.object(sys, 'stdout', stdout):
            with self.assertRaises(bridge.Closed):
                await bridge.requests(conn)
        self.assertEqual(len(conn.calls), 1)
        self.assertEqual(json.loads(stdout.buffer.getvalue())['error']['code'], 'outcome_uncertain')

    async def test_tool_and_hidden_fields_never_cross_event_projection(self):
        conn = Connection()
        await conn.events.put({'params': {'type': 'message.delta', 'payload': {'text': 'excluded partial'}}})
        await conn.events.put({'params': {'type': 'tool.complete', 'payload': {'secret': 'excluded'}}})
        await conn.events.put({'params': {'type': 'message.complete', 'session_id': 'session',
            'admission_id': 'admission', 'execution_generation': 1, 'replay_epoch': 'epoch', 'seq': 3,
            'payload': {'text': 'visible', 'outcome': 'completed', 'content': ['excluded'], 'reasoning': 'excluded'}}})
        await conn.events.put(RuntimeError('excluded'))
        stdout = Pipe()
        with patch.object(sys, 'stdout', stdout), self.assertRaises(bridge.Closed):
            await bridge.pump(conn)
        frames = stdout.buffer.getvalue().splitlines()
        self.assertEqual(len(frames), 1)
        self.assertNotIn(b'excluded', frames[0])
        self.assertEqual(json.loads(frames[0])['data']['params']['payload']['text'], 'visible')

    async def test_approval_is_denied_with_observed_fence(self):
        conn = Connection()
        await conn.events.put({'params': {'type': 'approval.request', 'session_id': 'session',
            'execution_generation': 7, 'payload': {'prompt_id': 'prompt', 'description': 'excluded'}}})
        await conn.events.put(RuntimeError('closed'))
        with patch.object(sys, 'stdout', Pipe()), self.assertRaises(bridge.Closed):
            await bridge.pump(conn)
        self.assertEqual(conn.calls, [('approval.respond', {'session_id': 'session',
            'execution_generation': 7, 'prompt_id': 'prompt', 'choice': 'deny'})])


if __name__ == '__main__':
    unittest.main()
