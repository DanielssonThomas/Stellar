import asyncio
import importlib.util
from pathlib import Path
import unittest

SOURCE = Path(__file__).resolve().parents[2] / 'apps/stellar-desktop/src-tauri/src/ivy/workspace_protocol.py'
spec = importlib.util.spec_from_file_location('workspace_protocol', SOURCE)
workspace = importlib.util.module_from_spec(spec)
spec.loader.exec_module(workspace)


class WorkspaceProtocolTests(unittest.IsolatedAsyncioTestCase):
    def test_render_observations_preserve_terminal_and_pending_states(self):
        pane = {'instance_id': 'pane', 'surface': 'image', 'prominence': 'primary', 'minimized': False}
        for state in ('ready', 'loading', 'error', 'hidden', 'unavailable', None):
            outcome = {'kind': 'inspection', 'panes': [{**pane, 'render_state': state}]}
            self.assertEqual(workspace.validate_outcome(outcome, 'inspect'), outcome)
        for state in ('success', True, [], {}):
            with self.assertRaises(workspace.WorkspaceRefused):
                workspace.validate_outcome({'kind': 'inspection', 'panes': [{**pane, 'render_state': state}]}, 'inspect')

    async def test_screen_targets_and_monitor_metadata_are_bounded_and_cancelled_images_are_rejected(self):
        display = {'id': 'monitor1', 'name': 'Left', 'width': 3840, 'height': 2160, 'primary': True, 'foreground': True}
        self.assertEqual(workspace.validate_outcome({'kind': 'displays', 'displays': [display]}, 'list_displays')['displays'], [display])
        for invalid in [{**display, 'width': True}, {**display, 'id': ''}, {**display, 'foreground': 'yes'}]:
            with self.assertRaises(workspace.WorkspaceRefused):
                workspace.validate_outcome({'kind': 'displays', 'displays': [invalid]}, 'list_displays')
        for operation in [{'kind': 'capture_display', 'display_id': None}, {'kind': 'capture_display', 'display_id': 'monitor1'}, {'kind': 'capture_foreground'}]:
            frames = []
            gate = workspace.WorkspaceGate(frames.append)
            token = gate.arm('1', 'turn')
            task = asyncio.create_task(gate.call(operation, token))
            await asyncio.sleep(0)
            request = frames[0]['data']
            header = {key: request[key] for key in ('version', 'request_id', 'epoch', 'turn_id')}
            gate.disarm()
            with self.assertRaises(workspace.WorkspaceRefused):
                gate.reply_image(header, b'\x89PNG\r\n\x1a\nimage')
            with self.assertRaises(workspace.WorkspaceRefused):
                await task
        for target in ['', 'a' * 129, '\0bad', 1]:
            with self.assertRaises(workspace.WorkspaceRefused):
                workspace.validate_operation({'kind': 'capture_display', 'display_id': target})

    def test_operations_reject_unknown_keys_bad_ids_and_ambiguous_json(self):
        valid = {'kind': 'open', 'instance_id': 'pane_1', 'surface': 'rich-text',
                 'payload_json': '{"text":"hello"}', 'prominence': 'primary'}
        self.assertEqual(workspace.validate_operation(valid), valid)
        for change in ({'extra': 1}, {'instance_id': '../other'}, {'surface': 'script'},
                       {'surface': []}, {'surface': 'activity-summary'}, {'prominence': []}, {'payload_json': '{"x":1,"x":2}'},
                       {'payload_json': '{"x":NaN}'}, {'payload_json': '{"x":1e999}'},
                       {'payload_json': '\ud800'}, {'payload_json': '[]'},
                       {'payload_json': '{"x":"' + 'a' * 65536 + '"}'}):
            with self.subTest(change=change), self.assertRaises(workspace.WorkspaceRefused):
                workspace.validate_operation({**valid, **change})
        for ids in (['a', 'a'], ['a'] * 5, ['../a']):
            with self.subTest(ids=ids), self.assertRaises(workspace.WorkspaceRefused):
                workspace.validate_operation({'kind': 'arrange', 'instance_ids': ids})

    def test_split_layout_and_composition_validate_before_any_dispatch(self):
        leaf = lambda name: {'kind': 'pane', 'instance_id': name}
        tree = {'kind': 'split', 'split_id': 'main', 'axis': 'vertical', 'percent': 50, 'first': leaf('a'), 'second': leaf('b')}
        self.assertEqual(workspace.validate_operation({'kind': 'set_layout', 'tree': tree})['tree'], tree)
        for invalid in [{**tree, 'percent': True}, {**tree, 'percent': 99}, {**tree, 'second': leaf('a')}, {**tree, 'script': 'bad'}]:
            with self.assertRaises(workspace.WorkspaceRefused):
                workspace.validate_operation({'kind': 'set_layout', 'tree': invalid})
        panes = [{'instance_id': name, 'surface': 'rich-text', 'payload_json': '{}', 'prominence': 'secondary'} for name in ('a', 'b')]
        self.assertEqual(len(workspace.WorkspaceGate.validate_composition(panes, tree)), 2)
        for invalid in [panes + [panes[0]], [{**panes[0], 'surface': 'script'}], [{**panes[0], 'payload_json': '{"x":1,"x":2}'}]]:
            with self.assertRaises(workspace.WorkspaceRefused):
                workspace.WorkspaceGate.validate_composition(invalid, tree)
        self.assertEqual(workspace.validate_operation({'kind': 'resize_split', 'split_id': 'main', 'percent': 50})['percent'], 50)

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
            {'instance_id': 'a', 'surface': 'activity-summary', 'prominence': 'primary', 'minimized': False}]}
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


class InteractiveWorkspaceTests(unittest.TestCase):
    def test_layout_operations_and_revision_are_strictly_typed(self):
        valid = [{'kind': 'resize', 'instance_id': 'a', 'percent': 65},
                 {'kind': 'swap', 'instance_id': 'a', 'other_id': 'b'},
                 {'kind': 'restore_layout'}, {'kind': 'inspect_content', 'instance_id': 'a'},
                 {'kind': 'update', 'instance_id': 'a', 'surface': 'rich-text', 'payload_json': '{}', 'expected_revision': 2}]
        for operation in valid:
            self.assertEqual(workspace.validate_operation(operation), operation)
        for percent in [True, 9, 91, 50.5, '65']:
            with self.assertRaises(workspace.WorkspaceRefused):
                workspace.validate_operation({'kind': 'resize', 'instance_id': 'a', 'percent': percent})
        for revision in [True, -1, 4294967296, '2']:
            with self.assertRaises(workspace.WorkspaceRefused):
                workspace.validate_operation({**valid[-1], 'expected_revision': revision})
        with self.assertRaises(workspace.WorkspaceRefused):
            workspace.validate_operation({'kind': 'swap', 'instance_id': 'a', 'other_id': 'a'})

    def test_compact_layout_metadata_rejects_payload_and_invalid_geometry(self):
        pane = {'instance_id': 'a', 'surface': 'image', 'prominence': 'primary', 'minimized': False,
                'layout': {'title': 'Gallery', 'revision': 2, 'selected': True, 'maximized': False,
                           'position': 0, 'x': 0, 'y': 0, 'width': 650, 'height': 1000}}
        value = {'kind': 'inspection', 'panes': [pane]}
        self.assertEqual(workspace.validate_outcome(value, 'inspect'), value)
        with self.assertRaises(workspace.WorkspaceRefused):
            workspace.validate_outcome({'kind': 'inspection', 'panes': [{**pane, 'layout': {**pane['layout'], 'width': 1001}}]}, 'inspect')
        content = {'kind': 'content', 'instance_id': 'a', 'surface': 'image', 'revision': 2, 'payload_json': '{}'}
        self.assertEqual(workspace.validate_outcome(content, 'inspect_content'), content)
        with self.assertRaises(workspace.WorkspaceRefused):
            workspace.validate_outcome(content, 'inspect')


if __name__ == '__main__':
    unittest.main()
