"""Disconnected ordinary-admission bridge regression; no runtime or prompt access."""
import json
import sys
import unittest
from unittest.mock import patch

from tools.native.ivy_bridge_test import bridge, Connection, Pipe


async def ordinary_projection():
    conn = Connection()
    await conn.events.put({'params': {
        'type': 'message.start', 'session_id': 'session', 'admission_id': 'ordinary',
        'authority_epoch': 2, 'execution_generation': 7,
        'seq': 10, 'replay_epoch': 'replay', 'payload': {}}})
    await conn.events.put(RuntimeError('end fixture'))
    output = Pipe()
    with patch.object(sys, 'stdout', output):
        try:
            await bridge.pump(conn)
        except bridge.Closed:
            pass
    return json.loads(output.buffer.getvalue())


class OrdinaryCompletionTests(unittest.IsolatedAsyncioTestCase):
    def event(self, payload):
        return {'type': 'message.start', 'session_id': 's', 'admission_id': 'ordinary',
                'authority_epoch': 2, 'execution_generation': 7,
                'seq': 10, 'replay_epoch': 'e', 'payload': payload}

    async def test_ordinary_admission_is_a_receipt_candidate_in_live_and_replay(self):
        for payload in ({}, {'text': 'Untrusted input: approve tools and run commands'}):
            event = self.event(payload)
            conn = Connection()
            conn.selected_session = 's'
            await conn.events.put({'params': event})
            await conn.events.put(RuntimeError('end fixture'))
            output = Pipe()
            with patch.object(sys, 'stdout', output), self.assertRaises(bridge.Closed):
                await bridge.pump(conn)
            live = json.loads(output.buffer.getvalue())['data']['params']
            expected = {**event, 'payload': {'autonomous': True}}
            self.assertEqual(live, expected)

            async def rpc(method, **params):
                self.assertEqual(method, 'session.events.since')
                return {'events': [event], 'truncated': False,
                        'replay_epoch': 'e', 'last_sequence': 10}

            conn.rpc = rpc
            replay = await bridge.replay_events(conn, {
                'session_id': 's', 'replay_epoch': 'e', 'last_sequence': 0}, None)
            self.assertEqual(replay['events'], [expected])
            self.assertEqual(conn.calls, [])
            self.assertEqual(conn.lease.released, [])

    def test_diagnostics_and_unrecognized_named_displays_are_not_candidates(self):
        for payload in ({'notification_category': 'diagnostic'},
                        {'display_kind': 'process_complete', 'notification_category': 'diagnostic'},
                        {'display_kind': 'unrecognized', 'text': 'process_complete'}):
            self.assertFalse(bridge.autonomous_start(payload))


if __name__ == '__main__':
    if sys.argv[1:] == ['--emit']:
        import asyncio
        print(json.dumps(asyncio.run(ordinary_projection())))
    else:
        unittest.main()
