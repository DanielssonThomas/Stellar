"""Serialized private bridge regression, not a helper-only mock or live qualification."""
import asyncio
import json
import sys
import unittest
import copy
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parent))
from ivy_retained_wire_fixture import bridge, connection, Workspace, retained
from ivy_bridge_test import Pipe
CONTRACT = json.loads((Path(__file__).resolve().parents[2] / 'apps/stellar-desktop/src/app/testing/retained-recovery-wire.json').read_text())


async def exchange(conn, workspace, method, params):
    queue = asyncio.Queue()
    raw = json.dumps({'id': 1, 'method': method, 'params': params})
    await queue.put(bridge.validate(json.loads(raw, object_pairs_hook=bridge.pairs)))
    await queue.put(None)
    output = Pipe()
    with patch.object(bridge, 'PROFILE', 'fixture'), patch.object(sys, 'stdout', output):
        await bridge.request_worker(conn, workspace, queue)
    return json.loads(output.buffer.getvalue())


class RetainedWireTests(unittest.IsolatedAsyncioTestCase):
    async def test_nullable_current_selection_survives_the_wire_without_creating_a_session(self):
        conn, workspace = connection(), Workspace()
        conn.selected_session = None
        frame = await exchange(conn, workspace, 'session.load.prepare', {'session_id':'retained'})
        self.assertIn('current_session_id', frame['result'])
        self.assertIsNone(frame['result']['current_session_id'])
        self.assertFalse(conn.client.mutations)

    async def test_malformed_prepare_fields_are_refused_by_actual_wire_before_mutation(self):
        good = {'session_id':'retained','stored_session_id':'physical','model':'gpt-6.1-sol',
                'revision':4,'generation':2,'edit_policy':'ask','current_session_id':'current'}
        cases = [('model',{}),('edit_policy',[]),('revision',True),('generation',2**64),
                 ('current_session_id','bad\nidentity'),('stored_session_id','\ud800'),
                 ('private_transport','PRIVATE secret')]
        for key, value in cases:
            conn, workspace = connection(), Workspace()
            bad = {**good, key:value}
            async def malformed(*args): return copy.deepcopy(bad)
            with self.subTest(key=key), patch.object(retained, 'prepare', malformed):
                reply = await exchange(conn, workspace, 'session.load.prepare', {'session_id':'retained'})
            self.assertEqual(reply, {'id':1,'error':{'code':'protocol'}})
            self.assertNotIn('PRIVATE', json.dumps(reply))
            self.assertFalse(conn.client.mutations)

    async def test_bad_confirmation_is_uncertain_after_effect_and_does_not_leak_or_retry(self):
        conn, workspace = connection(), Workspace()
        original = retained.commit
        async def malformed(*args):
            result = await original(*args)
            return {**result, 'private_transport':'PRIVATE secret'}
        request = {'session_id':'retained','stored_session_id':'physical','request_id':'fixed-once',
                   'revision':4,'generation':2,'model':'gpt-6.1-sol','edit_policy':'ask','current_session_id':'current'}
        with patch.object(retained, 'commit', malformed):
            frame = await exchange(conn, workspace, 'session.load', request)
        self.assertEqual(frame, {'id':1,'error':{'code':'outcome_uncertain'}})
        self.assertNotIn('PRIVATE', json.dumps(frame))
        self.assertEqual(len(conn.client.mutations),1)

    async def test_commit_wire_keeps_model_and_cannot_drop_the_confirmation(self):
        conn, workspace = connection(), Workspace()
        reply = await exchange(conn, workspace, 'session.load', {
            'session_id':'retained','stored_session_id':'physical','request_id':'fixed-once',
            'revision':4,'generation':2,'model':'gpt-6.1-sol','edit_policy':'ask','current_session_id':'current'})
        self.assertEqual(reply['result']['model'], 'gpt-6.1-sol')
        self.assertEqual(len(conn.client.mutations), 1)

    async def test_actual_prepare_worker_preserves_busy_approval_refusal_before_effect(self):
        conn, workspace = connection(), Workspace()
        conn.client.state['open_requests'] = [{'prompt_id':'foreign-approval'}]
        reply = await exchange(conn, workspace, 'session.load.prepare', {'session_id':'retained'})
        self.assertEqual(reply, {'id':1,'error':{'code':'busy'}})
        self.assertFalse(conn.client.mutations)
        self.assertEqual(workspace.owner_session, 'current')

    async def test_prepare_and_commit_survive_actual_worker_projection_and_jsonl(self):
        conn, workspace = connection(), Workspace()
        prepared = (await exchange(conn, workspace, 'session.load.prepare', {'session_id': 'retained'}))['result']
        self.assertEqual(prepared, CONTRACT['prepare_result'])
        self.assertEqual(prepared['model'], 'gpt-6.1-sol')
        self.assertEqual(prepared['edit_policy'], 'ask')
        self.assertEqual(prepared['current_session_id'], 'current')
        self.assertFalse(conn.client.mutations)
        reply = await exchange(conn, workspace, 'session.load', {**prepared, 'request_id': 'one-load'})
        self.assertEqual(reply['result'], {'session_id': 'retained', 'stored_session_id': 'physical', 'model': 'gpt-6.1-sol'})
        self.assertEqual(reply['result'], CONTRACT['commit_result'])
        self.assertEqual(len(conn.client.mutations), 1)
        self.assertEqual(workspace.owner_session, 'retained')
        self.assertNotIn('inert-own-token', json.dumps([prepared, reply]))
        self.assertEqual(conn.client.history, ['user question', 'original answer'])


if __name__ == '__main__':
    unittest.main()
