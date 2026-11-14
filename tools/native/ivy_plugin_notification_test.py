"""Consumer checks against unmodified canonical frames captured in disposable Hermes source."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

from tools.native.ivy_bridge_test import bridge, Connection, Pipe
from stellar_ivy_notifications import inspect_forward, forwarded

DATA = json.loads(Path(os.environ.get('STELLAR_PLUGIN_NOTIFICATION_FIXTURE',
    Path(__file__).parent / 'evidence/plugin-notification-canonical-v1.json')).read_text(encoding='utf-8'))
if DATA.get('fixture_only') is not True:
    raise ValueError('Expected disconnected canonical frame fixture')
START = next(row['params'] for row in DATA['frames'] if row['params']['type'] == 'message.start')
REVOKE = next(row['params'] for row in DATA['frames'] if row['params']['type'].endswith('.revoked'))
FORWARD = json.loads((Path(__file__).parent / 'evidence/stellar-herdr-notification-forward-v1.json').read_text(encoding='utf-8'))


class ForwardingTests(unittest.IsolatedAsyncioTestCase):
    def connection(self):
        conn = Connection()
        conn.selected_session = FORWARD['binding']['owner_session_id']
        conn.active = {'session_id': conn.selected_session, 'admission_id': 'unrelated-foreground'}
        return conn

    async def test_canonical_start_duplicate_completion_and_revoke_preserve_provenance(self):
        conn = self.connection()
        for value in [FORWARD['raw_start'], FORWARD['raw_terminal'], FORWARD['raw_terminal'], FORWARD['raw_revoke']]:
            await conn.events.put(value)
        await conn.events.put(RuntimeError('fixture end'))
        output, cancellations = Pipe(), []
        class Approvals:
            async def cancel(self, sid=None):
                if sid is not None:
                    cancellations.append(sid)
        with patch.object(bridge, 'PROFILE', FORWARD['binding']['profile_id']), patch.object(sys, 'stdout', output), self.assertRaises(bridge.Closed):
            await bridge.pump(conn, approvals=Approvals())
        frames = [json.loads(row)['data']['params'] for row in output.buffer.getvalue().splitlines()]
        descriptor = FORWARD['raw_start']['params']['payload']['plugin_notification']
        for frame in frames[:3]:
            self.assertEqual(frame['payload'], {'plugin_notification': descriptor})
        self.assertEqual(frames[3]['payload'], FORWARD['raw_revoke']['params']['payload'])
        self.assertEqual(cancellations, [])
        self.assertEqual(conn.completed, set())
        self.assertEqual(conn.lease.released, [])
        self.assertEqual(conn.active['admission_id'], 'unrelated-foreground')

    async def test_authenticated_inspection_restores_retained_custody_and_projects_only_final(self):
        conn = self.connection()
        reply = copy.deepcopy(FORWARD['producer_inspection_rpc']['result'])
        reply['host']['result']['result']['private'] = 'excluded'
        async def rpc(method, **params):
            conn.calls.append((method, params))
            return reply
        conn.rpc = rpc
        descriptor = FORWARD['raw_start']['params']['payload']['plugin_notification']
        params = {'session_id': conn.selected_session, 'admission_id': FORWARD['raw_start']['params']['admission_id'], 'descriptor': descriptor}
        result = await inspect_forward(conn, params, FORWARD['binding']['profile_id'], 1)
        self.assertEqual(conn.calls, [('plugin.stellar-herdr.observations.inspect', {'session_id':conn.selected_session, 'event_id':descriptor['event_id']})])
        self.assertEqual(set(result['host']['result']['result']), {'final_response'})
        await conn.events.put(FORWARD['raw_terminal'])
        await conn.events.put(RuntimeError('fixture end'))
        output = Pipe()
        with patch.object(bridge, 'PROFILE', FORWARD['binding']['profile_id']), patch.object(sys, 'stdout', output), self.assertRaises(bridge.Closed):
            await bridge.pump(conn)
        self.assertEqual(json.loads(output.buffer.getvalue())['data']['params']['payload'], {'plugin_notification':descriptor})
        self.assertEqual(conn.completed, set())
        self.assertEqual(conn.lease.released, [])

    async def test_replay_canonical_start_terminal_and_revoke_are_not_ordinary_wakes(self):
        conn = self.connection()
        rows = [FORWARD[key]['params'] for key in ['raw_start', 'raw_terminal', 'raw_revoke']]
        async def rpc(method, **params):
            return {'events':rows, 'truncated':False, 'replay_epoch':rows[0]['replay_epoch'], 'last_sequence':rows[-1]['seq']}
        conn.rpc = rpc
        with patch.object(bridge, 'PROFILE', FORWARD['binding']['profile_id']):
            result = await bridge.replay_events(conn, {'session_id':conn.selected_session, 'replay_epoch':rows[0]['replay_epoch'], 'last_sequence':0}, None)
        self.assertEqual(result['events'][0]['payload'], result['events'][1]['payload'])
        self.assertNotIn('autonomous', result['events'][0]['payload'])
        self.assertEqual(result['events'][2]['payload'], rows[-1]['payload'])

    def test_exact_producer_meaningful_answer_predicate_and_local_fence(self):
        original = FORWARD['producer_inspection_rpc']['result']
        descriptor = FORWARD['raw_start']['params']['payload']['plugin_notification']
        admission = FORWARD['raw_start']['params']['admission_id']
        for final in ['', '  ', 'a' * 262145, None]:
            reply = copy.deepcopy(original)
            reply['delivery_allowed'] = False
            reply['host']['result'] = None if final is None else {'result':{'final_response':final}}
            self.assertFalse(forwarded(reply, descriptor, admission)['delivery_allowed'])
        reply = copy.deepcopy(original)
        reply.update(local_eligible=False, delivery_allowed=False)
        self.assertTrue(reply['host']['delivery_allowed'])
        self.assertFalse(forwarded(reply, descriptor, admission)['delivery_allowed'])
        reply['delivery_allowed'] = True
        with self.assertRaises(ValueError):
            forwarded(reply, descriptor, admission)


class ProjectionRegression(unittest.IsolatedAsyncioTestCase):
    def test_named_wake_alone_is_not_admitted_and_marker_cannot_forge_process_kind(self):
        self.assertFalse(bridge.autonomous_start({'display_kind': 'internal_notification'}))
        for kind in [None, 'process_complete', 'async_delegation_complete']:
            with self.assertRaises(bridge.Closed):
                bridge.autonomous_start({'display_kind': kind,
                    'plugin_notification': START['payload']['plugin_notification']})

    async def test_foreign_plugin_marker_is_not_silently_downgraded(self):
        conn = Connection()
        conn.selected_session = START['session_id']
        await conn.events.put({'params': START})
        await conn.events.put(RuntimeError('end fixture'))
        output = Pipe()
        with patch.object(sys, 'stdout', output), self.assertRaises(bridge.Closed):
            await bridge.pump(conn)
        self.assertEqual(output.buffer.getvalue(), b'')
        self.assertEqual(conn.calls, [])
        self.assertEqual(conn.lease.released, [])

    async def test_replay_refuses_foreign_plugin_marker(self):
        conn = Connection()
        conn.selected_session = START['session_id']
        async def rpc(method, **params):
            return {'events': [START], 'truncated': False, 'replay_epoch': START['replay_epoch'],
                    'last_sequence': START['seq']}
        conn.rpc = rpc
        with self.assertRaises(bridge.Closed):
            await bridge.replay_events(conn, {'session_id': START['session_id'],
                'replay_epoch': START['replay_epoch'], 'last_sequence': 0}, None)

    async def test_foreign_marker_does_not_terminate_selected_foreground_delivery(self):
        conn = Connection()
        conn.selected_session = 'other-session'
        await conn.events.put({'params': START})
        await conn.events.put({'params': {**START, 'session_id': 'other-session',
                                         'payload': {}}})
        await conn.events.put(RuntimeError('end fixture'))
        output = Pipe()
        with patch.object(sys, 'stdout', output), self.assertRaises(bridge.Closed):
            await bridge.pump(conn)
        rows = [json.loads(row) for row in output.buffer.getvalue().splitlines()]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['data']['params']['session_id'], 'other-session')


class CandidateCodecTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location(
            'notice_codec', Path(__file__).resolve().parents[2] /
            'apps/stellar-desktop/src-tauri/src/ivy/ivy_notifications.py')
        cls.codec = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.codec)

    def marker(self):
        return self.codec.marker(START['payload']['plugin_notification'], DATA['expected_profile'],
                                 START['session_id'], DATA['expected_plugin'])

    def test_canonical_binding_digest_and_queued_started_completed_denied_states(self):
        marker = self.marker()
        for name in ['queued', 'started', 'terminal', 'denied']:
            result = self.codec.inspection(DATA[name], marker, START['admission_id'])
            self.assertEqual(result['delivery_allowed'], name == 'terminal')
        terminal = self.codec.inspection(DATA['terminal'], marker, START['admission_id'])
        self.assertEqual(terminal['descriptor'], START['payload']['plugin_notification'])
        self.assertEqual(terminal['result']['result']['final_response'],
                         DATA['terminal']['result']['result']['final_response'])
        self.assertEqual(self.codec.inspection(DATA['unknown'],
            {**marker, 'event_id': DATA['unknown']['event_id']}, None)['status'], 'unknown')

    def test_changed_full_binding_event_digest_and_receipt_are_rejected(self):
        marker = self.marker()
        for key in ['revision', 'expires_at', 'session_key', 'profile_id', 'owner_session_id', 'plugin_id']:
            changed = copy.deepcopy(DATA['terminal'])
            changed['descriptor']['binding'][key] = 999 if key in ['revision', 'expires_at'] else 'foreign'
            with self.assertRaises(ValueError, msg=key):
                self.codec.inspection(changed, marker, START['admission_id'])
        for field in ['event_id', 'payload_digest']:
            changed = copy.deepcopy(DATA['terminal'])
            changed['descriptor'][field] = 'f' * 64
            with self.assertRaises(ValueError, msg=field):
                self.codec.inspection(changed, marker, START['admission_id'])
        for field in ['admission_id', 'execution_generation', 'authority_epoch']:
            changed = copy.deepcopy(DATA['terminal'])
            changed['receipt'][field] = 'foreign' if field == 'admission_id' else True
            with self.assertRaises(ValueError, msg=field):
                self.codec.inspection(changed, marker, START['admission_id'])

    def test_revoke_uses_exact_binding_not_ambient_foreground_stamp_or_inflight_only(self):
        value = self.codec.revocation(REVOKE['payload'], DATA['expected_profile'],
                                      START['session_id'], DATA['expected_plugin'])
        self.assertEqual(value['binding'], DATA['binding'])
        self.assertEqual(value['in_flight'], [])
        self.assertEqual(value['binding']['revision'], 1)

    def test_real_cancelled_null_generation_and_retired_descriptor_are_non_authorizing(self):
        cancelled = DATA['cancelled']
        expected = self.codec.marker(cancelled['descriptor'], DATA['expected_profile'],
                                      START['session_id'], DATA['expected_plugin'])
        result = self.codec.inspection(cancelled, expected, cancelled['receipt']['admission_id'])
        self.assertIsNone(result['receipt']['execution_generation'])
        self.assertFalse(result['delivery_allowed'])
        retired = self.codec.inspection(DATA['tombstone'], self.marker(), START['admission_id'])
        self.assertIsNone(retired['descriptor'])
        self.assertFalse(retired['delivery_allowed'])

    def test_same_binding_hash_does_not_hide_a_different_revision(self):
        old, newer = DATA['revoked']['binding'], DATA['newer_revoke']['binding']
        self.assertEqual(old['binding_id'], newer['binding_id'])
        self.assertNotEqual(old, newer)
        with self.assertRaises(ValueError):
            self.codec.inspection(DATA['cancelled'], self.marker(), None)

    def test_malformed_and_missing_delivery_proof_fail_closed(self):
        for field, invalid in [('schema_version', True), ('event_id', ''),
                               ('payload_digest', 'G' * 64)]:
            changed = copy.deepcopy(START['payload']['plugin_notification'])
            changed[field] = invalid
            with self.assertRaises(ValueError):
                self.codec.marker(changed, DATA['expected_profile'], START['session_id'], DATA['expected_plugin'])
        for field, invalid in [('revision', True), ('revision', 1.0), ('expires_at', float('nan'))]:
            changed = copy.deepcopy(START['payload']['plugin_notification'])
            changed['binding'][field] = invalid
            with self.assertRaises(ValueError):
                self.codec.marker(changed, DATA['expected_profile'], START['session_id'], DATA['expected_plugin'])
        for field, invalid in [('delivery_allowed', 'true'), ('descriptor', None)]:
            changed = copy.deepcopy(DATA['terminal'])
            changed[field] = invalid
            with self.assertRaises(ValueError):
                self.codec.inspection(changed, self.marker(), START['admission_id'])

    def test_receipt_state_contradictions_are_not_delivery_evidence(self):
        for status in ['queued', 'started', 'unknown', 'terminal']:
            changed = copy.deepcopy(DATA['terminal'])
            changed['delivery_allowed'] = False
            changed['receipt']['status'] = status
            if status == 'queued':
                changed['receipt']['execution_generation'] = None
            if status == 'terminal':
                changed['receipt']['outcome'] = None
            with self.assertRaises(ValueError, msg=status):
                self.codec.inspection(changed, self.marker(), START['admission_id'])
        for field, value in [('execution_generation', None), ('status', 'started'),
                             ('outcome', None), ('sequence', True)]:
            changed = copy.deepcopy(DATA['terminal'])
            changed['receipt'][field] = value
            with self.assertRaises(ValueError):
                self.codec.inspection(changed, self.marker(), START['admission_id'])
        rejected = copy.deepcopy(DATA['terminal'])
        rejected['receipt']['outcome'] = 'rejected'
        rejected['delivery_allowed'] = False
        self.assertFalse(self.codec.inspection(rejected, self.marker(), START['admission_id'])['delivery_allowed'])
        malformed = copy.deepcopy(START['payload']['plugin_notification'])
        malformed['binding']['expires_at'] = 10**1000
        with self.assertRaises(ValueError):
            self.codec.marker(malformed, DATA['expected_profile'], START['session_id'], DATA['expected_plugin'])
        pending = copy.deepcopy(DATA['queued'])
        pending['result'] = DATA['terminal']['result']
        self.assertFalse(self.codec.inspection(pending, self.marker(), START['admission_id'])['delivery_allowed'])
        for result in ['invalid', {'result': []}, {'result': {'final_response': 7}}]:
            denied = copy.deepcopy(DATA['denied'])
            denied['result'] = result
            with self.assertRaises(ValueError):
                self.codec.inspection(denied, self.marker(), START['admission_id'])


if __name__ == '__main__':
    unittest.main()
