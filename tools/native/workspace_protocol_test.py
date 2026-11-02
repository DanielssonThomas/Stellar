import asyncio
import importlib.util
from pathlib import Path
import unittest

SOURCE = Path(__file__).resolve().parents[2] / 'apps/stellar-desktop/src-tauri/src/ivy/workspace_protocol.py'
spec = importlib.util.spec_from_file_location('workspace_protocol', SOURCE)
workspace = importlib.util.module_from_spec(spec)
spec.loader.exec_module(workspace)


class WorkspaceProtocolTests(unittest.IsolatedAsyncioTestCase):
    def test_operations_reject_unknown_keys_bad_ids_and_ambiguous_json(self):
        valid = {'kind': 'open', 'instance_id': 'pane_1', 'surface': 'rich-text',
                 'payload_json': '{"text":"hello"}', 'prominence': 'primary'}
        self.assertEqual(workspace.validate_operation(valid), valid)
        for change in ({'extra': 1}, {'instance_id': '../other'}, {'surface': 'script'},
                       {'surface': []}, {'prominence': []}, {'payload_json': '{"x":1,"x":2}'},
                       {'payload_json': '{"x":NaN}'}, {'payload_json': '{"x":1e999}'},
                       {'payload_json': '\ud800'}, {'payload_json': '[]'},
                       {'payload_json': '{"x":"' + 'a' * 65536 + '"}'}):
            with self.subTest(change=change), self.assertRaises(workspace.WorkspaceRefused):
                workspace.validate_operation({**valid, **change})
        for ids in (['a', 'a'], ['a'] * 5, ['../a']):
            with self.subTest(ids=ids), self.assertRaises(workspace.WorkspaceRefused):
                workspace.validate_operation({'kind': 'arrange', 'instance_ids': ids})

    async def test_single_pending_reply_is_fenced_and_returns_actual_result(self):
        emitted = []
        gate = workspace.WorkspaceGate(emitted.append)
        token = gate.arm('4', 'turn-one')
        task = asyncio.create_task(gate.call({'kind': 'inspect'}, token))
        await asyncio.sleep(0)
        request = emitted[0]['data']
        self.assertEqual(request['turn_id'], 'turn-one')
        with self.assertRaises(workspace.WorkspaceRefused):
            await gate.call({'kind': 'clear'}, token)
        reply = {key: request[key] for key in ('version', 'request_id', 'epoch', 'turn_id')}
        reply['outcome'] = {'kind': 'inspection', 'panes': [
            {'instance_id': 'a', 'surface': 'image', 'prominence': 'primary', 'minimized': False}]}
        with self.assertRaises(workspace.WorkspaceRefused):
            gate.reply({**reply, 'epoch': '5'})
        gate.reply(reply)
        self.assertEqual(await task, reply['outcome'])
        with self.assertRaises(workspace.WorkspaceRefused):
            gate.reply(reply)

    async def test_turn_capability_is_not_forwarded_in_pane_payload(self):
        emitted = []
        gate = workspace.WorkspaceGate(emitted.append)
        token = gate.arm('4', 'turn-one')
        escaped = ''.join('\\u%04x' % ord(character) for character in token)
        operation = {'kind': 'open', 'instance_id': 'pane', 'surface': 'rich-text',
                     'payload_json': '{"body":"' + escaped + '"}', 'prominence': 'primary'}
        with self.assertRaises(workspace.WorkspaceRefused):
            await gate.call(operation, token)
        self.assertEqual(emitted, [])

    async def test_disarm_and_timeout_reject_late_replies_even_after_rearm(self):
        emitted = []
        gate = workspace.WorkspaceGate(emitted.append, timeout=0.01)
        old_token = gate.arm('1', 'first')
        old_task = asyncio.create_task(gate.call({'kind': 'clear'}, old_token))
        await asyncio.sleep(0)
        old = emitted[0]['data']
        gate.disarm()
        with self.assertRaises(workspace.WorkspaceRefused):
            await old_task
        token = gate.arm('2', 'second')
        with self.assertRaises(workspace.WorkspaceRefused):
            await gate.call({'kind': 'clear'}, old_token)
        new_task = asyncio.create_task(gate.call({'kind': 'clear'}, token))
        await asyncio.sleep(0)
        reply = {key: old[key] for key in ('version', 'request_id', 'epoch', 'turn_id')}
        with self.assertRaises(workspace.WorkspaceRefused):
            gate.reply({**reply, 'outcome': {'kind': 'applied'}})
        with self.assertRaises(asyncio.TimeoutError):
            await new_task
        with self.assertRaises(workspace.WorkspaceRefused):
            gate.reply({**reply, 'outcome': {'kind': 'applied'}})

    def test_inspection_never_accepts_payload_or_extra_metadata(self):
        with self.assertRaises(workspace.WorkspaceRefused):
            workspace.validate_outcome({'kind': 'inspection', 'panes': [
                {'instance_id': 'a', 'surface': 'image', 'prominence': 'primary',
                 'minimized': False, 'payload': 'private'}]}, 'inspect')

    async def test_capture_is_single_pending_and_disarm_rejects_late_image(self):
        emitted = []
        gate = workspace.WorkspaceGate(emitted.append)
        token = gate.arm('1', 'turn-one')
        pending = asyncio.create_task(gate.call({'kind': 'capture_window'}, token))
        await asyncio.sleep(0)
        request = emitted[0]['data']
        self.assertNotIn(token, str(request))
        header = {key: request[key] for key in ('version', 'request_id', 'epoch', 'turn_id')}
        with self.assertRaises(workspace.WorkspaceRefused):
            await gate.call({'kind': 'clear'}, token)
        gate.disarm()
        with self.assertRaises(workspace.WorkspaceRefused):
            gate.reply_image(header, b'\x89PNG\r\n\x1a\nimage')
        with self.assertRaises(workspace.WorkspaceRefused):
            await pending


if __name__ == '__main__':
    unittest.main()
