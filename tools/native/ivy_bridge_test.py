import asyncio
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
SOURCE = Path(__file__).resolve().parents[2] / 'apps/stellar-desktop/src-tauri/src/ivy/ivy_bridge.py'
spec = importlib.util.spec_from_file_location('bridge', SOURCE)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
for name, filename in [('stellar_ivy_activity', 'ivy_activity.py'), ('stellar_ivy_controls', 'ivy_controls.py')]:
    module_spec = importlib.util.spec_from_file_location(name, SOURCE.with_name(filename))
    module = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(module)
    sys.modules[name] = module


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
        self.sessions = set()
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
    async def test_first_text_availability_is_bounded_content_free_and_not_narratable(self):
        conn = Connection()
        for seq in range(1, 5):
            await conn.events.put({'params': {'type': 'message.delta', 'session_id': 'session',
                'admission_id': 'admission', 'execution_generation': 1, 'replay_epoch': 'epoch', 'seq': seq,
                'payload': {'text': '{"stellar_presentation":"private partial"', 'reasoning': 'private'}}})
        await conn.events.put(RuntimeError('stop fixture'))
        stdout = Pipe()
        with patch.object(sys, 'stdout', stdout), self.assertRaises(bridge.Closed):
            await bridge.pump(conn)
        frames = [json.loads(line) for line in stdout.buffer.getvalue().splitlines()]
        self.assertEqual(len(frames), 1)
        self.assertEqual(frames[0]['data']['params']['type'], 'stellar.first_text')
        self.assertEqual(frames[0]['data']['params']['payload'], {'available': True})
        self.assertNotIn('private', stdout.buffer.getvalue().decode())

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

    async def test_fixed_model_creation_checks_capability_and_projects_route(self):
        conn = Connection()
        async def call(method, params):
            return {'session_create': {'parameters': ['model', 'provider']}}
        async def rpc(method, **params):
            self.assertEqual(params['provider'], 'openai-codex')
            self.assertEqual(params['model'], 'gpt-6.1-sol')
            return {'session_id': 'sid', 'info': {'model': params['model'], 'launch_request': {'model': params['model'], 'provider': params['provider']}, 'secret': 'hidden'}}
        conn.call, conn.rpc = call, rpc
        stdout = Pipe()
        request = b'{"id":1,"method":"session.create","params":{"request_id":"abc","model":"gpt-6.1-sol"}}\n'
        with patch.object(sys, 'stdin', Pipe(request)), patch.object(sys, 'stdout', stdout):
            await bridge.requests(conn)
        self.assertEqual(json.loads(stdout.buffer.getvalue()), {'id': 1, 'result': {'session_id': 'sid', 'model': 'gpt-6.1-sol'}})
        self.assertEqual(conn.sessions, {'sid'})

    async def test_mismatched_gateway_model_never_becomes_verified(self):
        conn = Connection()
        async def call(method, params):
            return {'session_create': {'parameters': ['model', 'provider']}}
        async def rpc(method, **params):
            return {'session_id': 'sid', 'info': {'model': 'gpt-6.1-terra', 'launch_request': {'model': params['model'], 'provider': params['provider']}}}
        conn.call, conn.rpc = call, rpc
        request = b'{"id":1,"method":"session.create","params":{"request_id":"abc","model":"gpt-6.1-sol"}}\n'
        with patch.object(sys, 'stdin', Pipe(request)), patch.object(sys, 'stdout', Pipe()):
            with self.assertRaises(bridge.Closed):
                await bridge.requests(conn)

    async def test_missing_model_capability_fails_closed(self):
        conn = Connection()
        request = b'{"id":1,"method":"session.create","params":{"request_id":"abc","model":"gpt-6.1-sol"}}\n'
        with patch.object(sys, 'stdin', Pipe(request)), patch.object(sys, 'stdout', Pipe()):
            with self.assertRaises(bridge.Closed):
                await bridge.requests(conn)
        self.assertEqual(conn.sessions, set())

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

    async def test_long_unicode_event_and_receipt_preserve_complete_text(self):
        text = '\U0001fa90"\\\n' * 100000
        conn = Connection()
        async def receipt(method, params):
            return {'status': 'terminal', 'result': {'final_response': text, 'secret': 'excluded'}}
        conn.call = receipt
        stdin = Pipe(b'{"id":1,"method":"prompt.receipt","params":{"session_id":"s","admission_id":"a","include_result":true}}\n')
        stdout = Pipe()
        with patch.object(sys, 'stdin', stdin), patch.object(sys, 'stdout', stdout):
            await bridge.requests(conn)
        frame = json.loads(stdout.buffer.getvalue())
        self.assertEqual(frame['result']['result'], {'final_response': text})
        self.assertEqual(bridge.text_fields({'text': text, 'reasoning': 'excluded'}), {'text': text})

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


class ActivityTests(unittest.IsolatedAsyncioTestCase):
    async def test_tool_batches_keep_order_around_content_free_text_availability(self):
        conn = Connection()
        await conn.events.put({'params': self.event(1, name='mcp_example')})
        for seq in (2, 4):
            await conn.events.put({'params': {'type': 'message.delta', 'session_id': 's', 'admission_id': 'a',
                'execution_generation': 3, 'replay_epoch': 'e', 'seq': seq, 'payload': {'text': 'SECRET partial'}}})
            if seq == 2:
                await conn.events.put({'params': self.event(3, kind='tool.complete', name='mcp_example', result={'success': True})})
        await conn.events.put({'params': {'type': 'message.complete', 'session_id': 's', 'admission_id': 'a',
            'execution_generation': 3, 'replay_epoch': 'e', 'seq': 5, 'payload': {'outcome': 'completed', 'text': 'final'}}})
        await conn.events.put(RuntimeError('interrupted transport fixture'))
        output = Pipe()
        with patch.object(sys, 'stdout', output), self.assertRaises(bridge.Closed):
            await bridge.pump(conn)
        params = [json.loads(line)['data']['params'] for line in output.buffer.getvalue().splitlines()]
        self.assertEqual([value['type'] for value in params], ['stellar.activity', 'stellar.first_text', 'stellar.activity', 'message.complete'])
        self.assertEqual([value['seq'] for value in params], [1, 2, 3, 5])
        self.assertNotIn('SECRET', output.buffer.getvalue().decode())

    def event(self, seq, kind='tool.start', name='terminal', args=None, result=None):
        return {'type': kind, 'session_id': 's', 'admission_id': 'a', 'execution_generation': 3,
                'replay_epoch': 'e', 'seq': seq, 'payload': {'tool_id': str(seq), 'name': name,
                'args': args or {'command': 'SECRET'}, 'result': result}}

    def test_bounded_redaction_and_confirmed_special_operations(self):
        activity = sys.modules['stellar_ivy_activity'].Activity()
        for i in range(1000):
            activity.offer(self.event(i))
        batch = activity.flush()
        self.assertEqual(len(batch['payload']['actions']), 12)
        self.assertNotIn('SECRET', json.dumps(batch))
        self.assertEqual(batch['seq'], 999)
        self.assertIsNone(activity.flush())
        activity.offer(self.event(1000, name='skill_manage', args={'action': 'create', 'content': 'SECRET'}))
        self.assertEqual(activity.flush()['payload']['actions'][-1]['kind'], 'skill_create')
        activity.offer(self.event(1001, 'tool.complete', 'memory', {'action': 'add'}, {'success': True, 'staged': True, 'memory': 'SECRET'}))
        self.assertEqual(activity.flush()['payload']['actions'][-1]['state'], 'finished')
        activity.offer(self.event(1002, 'tool.complete', 'memory', {'action': 'add'}, {'success': True, 'memory': 'SECRET'}))
        self.assertEqual(activity.flush()['payload']['actions'][-1]['state'], 'completed')
        activity.offer(self.event(1003, 'tool.complete', 'memory', {'action': 'add'}, {'exit_code': 0}))
        self.assertEqual(activity.flush()['payload']['actions'][-1]['state'], 'finished')
        activity.offer(self.event(1004, 'tool.complete', result={'exit_code': 1}))
        self.assertEqual(activity.flush()['payload']['actions'][-1]['state'], 'failed')
        activity.offer(self.event(1005, 'tool.complete', result='looks successful but unstructured'))
        self.assertEqual(activity.flush()['payload']['actions'][-1]['state'], 'finished')

    def test_no_prompt_guessing_and_new_execution_replaces_old_rows(self):
        activity = sys.modules['stellar_ivy_activity'].Activity()
        activity.offer(self.event(1, name='terminal', args={'command': 'create skill and update memory'}))
        self.assertEqual(activity.flush()['payload']['actions'][0]['kind'], 'shell')
        event = self.event(2, name='memory', args={'action': 'read'})
        event['admission_id'] = 'new'
        activity.offer(event)
        batch = activity.flush()
        self.assertEqual(len(batch['payload']['actions']), 1)
        self.assertEqual(batch['payload']['actions'][0]['kind'], 'tool')
        event['seq'] = 1
        activity.offer(event)
        self.assertIsNone(activity.flush())

    async def test_bursts_are_coalesced_without_losing_terminal_message(self):
        conn = Connection()
        for i in range(300):
            await conn.events.put({'params': self.event(i)})
        await conn.events.put({'params': {'type': 'message.complete', 'session_id': 's', 'admission_id': 'a',
            'execution_generation': 3, 'replay_epoch': 'e', 'seq': 301, 'payload': {'outcome': 'completed', 'text': 'done'}}})
        await conn.events.put(RuntimeError())
        output = Pipe()
        with patch.object(sys, 'stdout', output), self.assertRaises(bridge.Closed):
            await bridge.pump(conn)
        frames = [json.loads(line) for line in output.buffer.getvalue().splitlines()]
        self.assertLessEqual(len(frames), 4)
        self.assertEqual(frames[-1]['data']['params']['type'], 'message.complete')
        self.assertNotIn('SECRET', output.buffer.getvalue().decode())


class ControlTests(unittest.IsolatedAsyncioTestCase):
    def connection(self, fresh=True, reload=None):
        conn = Connection()
        conn.sessions.add('s')
        conn.lease.acquire = lambda: None
        conn.lease.record = type('Record', (), {'exists': lambda _: False})()
        async def rpc(method, **params):
            conn.calls.append((method, params))
            if method == 'session.mutate':
                return {'operation': 'reset', 'session_id': 's', 'target_session_id': 'fresh',
                        'previous_target_session_id': 'old', 'execution_generation': 5}
            if method == 'reload.mcp':
                return reload or {'status': 'reloaded', 'session': 'unchanged'}
            return {'session_id': 's', 'messages': [] if fresh else [{'role': 'user', 'content': 'SECRET'}],
                    'message_count': 0 if fresh else 1, 'pending': [], 'running': False, 'execution_generation': 5}
        conn.rpc = rpc
        return conn

    async def test_reset_uses_native_fences_and_verifies_empty_backend_context(self):
        control = sys.modules['stellar_ivy_controls'].control
        conn = self.connection()
        reply = await control(conn, 'session.new', {'session_id': 's', 'request_id': 'r', 'revision': 7, 'generation': 4})
        self.assertEqual(reply, {'status': 'fresh', 'execution_generation': 5})
        self.assertEqual(conn.calls[0], ('session.mutate', {'session_id': 's', 'request_id': 'r',
            'expected_revision': 7, 'expected_generation': 4, 'operation': 'reset', 'payload': {}}))
        self.assertEqual([c[0] for c in conn.calls], ['session.mutate', 'session.resume'])
        self.assertEqual(conn.lease.released, [False])
        with self.assertRaises(sys.modules['stellar_ivy_controls'].Refused):
            await control(self.connection(fresh=False), 'session.new', {'session_id': 's', 'request_id': 'r', 'revision': 7, 'generation': 4})

    async def test_stale_writer_record_is_removed_only_after_matching_terminal_receipt(self):
        module = sys.modules['stellar_ivy_controls']
        for terminal in (False, True):
            with tempfile.TemporaryDirectory() as directory:
                conn = self.connection()
                conn.lease.record = Path(directory) / 'active.json'
                conn.lease.record.write_text(json.dumps({'session_id': 'old', 'admission_id': 'admission'}))
                original = conn.rpc
                async def rpc(method, **params):
                    if method == 'prompt.receipt':
                        return {'status': 'terminal' if terminal else 'running', 'ref': {'session_id': 'old'}, 'admission_id': 'admission'}
                    return await original(method, **params)
                conn.rpc = rpc
                if terminal:
                    self.assertEqual(await module.control(conn, 'integrations.reload', {'session_id': 's'}), {'status': 'reloaded'})
                    self.assertFalse(conn.lease.record.exists())
                else:
                    with self.assertRaises(module.Refused):
                        await module.control(conn, 'integrations.reload', {'session_id': 's'})
                    self.assertTrue(conn.lease.record.exists())
                    self.assertNotIn('reload.mcp', [call[0] for call in conn.calls])

    async def test_reload_is_explicit_and_partial_or_busy_is_not_success(self):
        module = sys.modules['stellar_ivy_controls']
        conn = self.connection()
        self.assertEqual(await module.control(conn, 'integrations.reload', {'session_id': 's'}), {'status': 'reloaded'})
        self.assertEqual(conn.calls[-1], ('reload.mcp', {'session_id': 's', 'confirm': True}))
        for result in [{'status': 'confirm_required'}, {'status': 'reloaded', 'session': 'busy'},
                       {'status': 'reloaded', 'unavailable': ['SECRET']}]:
            with self.assertRaises(module.Refused):
                await module.control(self.connection(reload=result), 'integrations.reload', {'session_id': 's'})
        conn = self.connection()
        conn.active = {'admission_id': 'running'}
        with self.assertRaises(module.Refused):
            await module.control(conn, 'integrations.reload', {'session_id': 's'})
        self.assertEqual(conn.calls, [])


if __name__ == '__main__':
    unittest.main()
