"""Qualify pinned host call sites on disposable source copies and real canonical SQLite.

Native connection/gesture/policy fixtures are synthetic; no live authentication, prompt,
profile, managed source, network, viewer, process worker or speech device is exercised.
"""
from __future__ import annotations

import argparse
import ast
import asyncio
from functools import partial
from dataclasses import replace
import importlib.abc
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[2]
EXAMPLES = {}


class HostTests(unittest.TestCase):
    def setUp(self):
        from hermes_state import SessionDB
        from hermes_state_runtime import begin_runtime_epoch
        from gateway.session_contract import SessionActor
        from stellar_background.host import Host
        from stellar_background.schema import install_schema
        self.tmp = tempfile.TemporaryDirectory(prefix='stellar339-host-db-')
        self.addCleanup(self.tmp.cleanup)
        self.db = SessionDB(Path(self.tmp.name) / 'canonical.db')
        self.addCleanup(self.db.close)
        self.db.create_session('original', source='local')
        install_schema(self.db)
        epoch = begin_runtime_epoch(self.db, instance_id='host-fixture')
        self.now, self.gesture, self.allowed = 1700000000000, object(), True
        self.scheduled = []
        self.authority = SimpleNamespace(db=self.db, profile_id='fixture-ivy', epoch=epoch,
            runner=SimpleNamespace(), sessions={'original': SimpleNamespace(route='fixture-route', detached=False)},
            events={'transport': object()}, _require_admission_open=lambda: None,
            physical_target=lambda ref: self.db.get_compression_tip(ref.session_id),
            _schedule_admitted=lambda ref, value: self.scheduled.append(ref.session_id),
            _publish_pending=lambda ref: None)
        def authorize(actor, ref, capability):
            from hermes_state_runtime import RuntimeStoreError
            if (actor.profile_id != ref.profile_id or ref.profile_id != 'fixture-ivy'
                    or ref.session_id not in self.authority.sessions or capability not in actor.capabilities):
                raise RuntimeStoreError('permission_denied')
        self.authority.authorize = authorize
        actor = SessionActor('native-owner', 'fixture-ivy', frozenset({'session:control'}), 'transport')
        self.authority._native_legacy_transports = {'transport': actor}
        self.connection = SimpleNamespace(authority=self.authority, actor=actor, subscriptions={'original': 'sub'})
        self.host = Host(self.authority, runtime_root=OVERLAY, verify_native=lambda c: c is self.connection,
            verify_gesture=lambda c, r, o, g: g is self.gesture,
            policy_gate=lambda c, b, v: self.allowed and v == 'fixture-v1', clock=lambda: self.now)
        self.db._stellar_background_host = self.host
        self.producer = self.host.register_producer('stellar-herdr', version='fixture-v1', incarnation='a' * 32)
        self.binding = self.bind()

    def approve(self, **extra):
        return self.host.approve(self.connection, 'original', producer_id='stellar-herdr',
            expires_at=self.now + 600000, max_admissions=8, gesture=extra.get('gesture', self.gesture))

    def bind(self):
        return self.host.bind(self.connection, 'original', self.approve())

    def event(self, event_id='e1'):
        return {'schemaVersion': 1, 'eventId': event_id, 'kind': 'lifecycle_update',
                'payload': {'milestone': 'waiting_review', 'fact': {'head': 'b' * 40}, 'observedAt': self.now}}

    def submit(self, event_id='e1'):
        return asyncio.run(self.producer.submit(self.binding['bindingId'], self.event(event_id)))

    def claim(self):
        from hermes_state_runtime import claim_session_input
        return claim_session_input(self.db, epoch=self.authority.epoch, session_id='original')

    def complete(self):
        from hermes_state_runtime import settle_session_input
        row = self.claim()
        return settle_session_input(self.db, epoch=self.authority.epoch, admission_id=row['admission_id'],
            generation=row['generation'], outcome='completed', result={'result': {'final_response': 'fixture answer'}})

    def consumer(self):
        return self.host.consumer(self.connection, 'original', self.binding['bindingId'])

    def assertCode(self, code, fn):
        from stellar_background import ContractError
        with self.assertRaises(ContractError) as raised:
            fn()
        self.assertEqual(raised.exception.code, code)

    def test_native_ticket_is_one_use_and_bound_to_actual_connection(self):
        ticket = self.approve()
        impostor = SimpleNamespace(**vars(self.connection))
        impostor.actor = replace(self.connection.actor, subject='another-owner')
        self.assertCode('permission_denied', lambda: self.host.bind(impostor, 'original', ticket))
        self.host.bind(self.connection, 'original', ticket)
        self.assertCode('consent_unavailable', lambda: self.host.bind(self.connection, 'original', ticket))
        self.assertCode('consent_unavailable', lambda: self.approve(gesture={'approved': True}))

    def test_native_wrong_profile_detach_and_unregistered_transport_refuse(self):
        actor = self.connection.actor
        for changed in (replace(actor, profile_id='other'), replace(actor, transport_id='forged')):
            self.connection.actor = changed
            with self.assertRaises(ValueError):
                self.approve()
        self.connection.actor = actor
        self.connection.subscriptions.clear()
        self.assertCode('permission_denied', self.approve)

    def test_real_fifo_guard_refuses_policy_change_then_foreground_can_run(self):
        from hermes_state_runtime import RuntimeStoreError, admit_session_input, cancel_session_input
        submitted = self.submit()
        self.allowed = False
        with self.assertRaises(RuntimeStoreError) as caught:
            self.claim()
        self.assertEqual(caught.exception.reason, 'admission_conflict')
        cancel_session_input(self.db, epoch=self.authority.epoch, admission_id=submitted['receipt']['admission_id'])
        foreground = admit_session_input(self.db, epoch=self.authority.epoch, principal_id='human',
            session_id='original', request_id='human-1', payload={'text': 'ordinary human input'})
        self.assertEqual(self.claim()['admission_id'], foreground['admission_id'])

    def test_claim_checks_exact_actual_fifo_not_a_stale_preflight(self):
        from hermes_state_runtime import claim_session_input
        first = self.submit()
        self.submit('e2')
        self.assertIs(claim_session_input(self.db, epoch=self.authority.epoch, session_id='original', head='stale'), False)
        self.assertEqual(self.claim()['admission_id'], first['receipt']['admission_id'])

    def test_cold_restart_and_removed_host_deny_reserved_queued_input(self):
        from hermes_state_runtime import RuntimeStoreError
        from stellar_background.host import Host
        self.submit()
        del self.db._stellar_background_host
        with self.assertRaises(RuntimeStoreError):
            self.claim()
        cold = Host(self.authority, runtime_root=OVERLAY, verify_native=lambda *a: False,
            verify_gesture=lambda *a: False, policy_gate=lambda *a: True, clock=lambda: self.now)
        self.db._stellar_background_host = cold
        with self.assertRaises(RuntimeStoreError):
            self.claim()
        cold.register_producer('stellar-herdr', version='fixture-v1', incarnation='c' * 32)
        with self.assertRaises(RuntimeStoreError):
            self.claim()  # a new worker incarnation cannot inherit the old grant

    def test_lost_ack_after_schedule_failure_reconciles_without_reexecution(self):
        def lost(*args):
            raise ConnectionError('synthetic ACK lost after durable commit')
        self.authority._schedule_admitted = lost
        with self.assertRaises(ConnectionError):
            self.submit()
        from stellar_background import event_digest
        receipt = self.producer.inspect(self.binding['bindingId'], 'e1', event_digest(self.binding, self.event()))
        self.assertEqual(receipt['status'], 'admitted')
        self.assertFalse(receipt['retryAuthorized'])
        self.assertEqual(self.claim()['admission_id'], receipt['receipt']['admission_id'])

    def test_public_prepare_freezes_digest_before_any_admission_attempt(self):
        event = self.event()
        prepared = self.producer.prepare(self.binding['bindingId'], event)
        event['payload']['fact']['head'] = 'changed-caller-value'
        self.assertEqual(prepared['event']['payload']['fact']['head'], 'b' * 40)
        before = self.producer.inspect(self.binding['bindingId'], 'e1', prepared['digest'])
        self.assertEqual(before['status'], 'unknown')
        self.assertFalse(before['retryAuthorized'])
        submitted = asyncio.run(self.producer.submit(self.binding['bindingId'], prepared['event']))
        self.assertEqual(submitted['descriptor']['digest'], prepared['digest'])

    def test_actual_terminal_write_suppresses_revoked_answer(self):
        from hermes_state_runtime import settle_session_input
        submitted = self.submit()
        started = self.claim()
        self.consumer().call('revoke', {})
        terminal = settle_session_input(self.db, epoch=self.authority.epoch, admission_id=started['admission_id'],
            generation=started['generation'], outcome='completed', result={'result': {'final_response': 'must disappear'}})
        self.assertEqual(terminal['outcome'], 'interrupted')
        info = self.consumer().call('inspect', {'eventId': 'e1', 'digest': submitted['descriptor']['digest']})
        self.assertEqual(info['receipt']['result']['final_response'], '')
        self.assertFalse(info['deliveryAuthorized'])

    def test_real_finish_result_does_not_publish_the_precommit_response(self):
        from gateway.session_results import finish_result
        self.submit()
        started = self.claim()
        self.consumer().call('revoke', {})
        # The unrelated restart-notice helper imports the full gateway bootstrap. Exclude that
        # helper explicitly; the actual finish_result, settlement and publication return run.
        with patch('gateway.session_settlement_recovery.owner_stop_notice', return_value=None):
            settled, response = finish_result(self.db, epoch=self.authority.epoch, row=started,
                response='must disappear', outcome='completed', prepared=('completed', {'result': {'final_response': 'must disappear'}}))
        self.assertEqual((settled['outcome'], response), ('interrupted', ''))

    def test_interrupted_partial_and_transformed_capture_cannot_resurrect_answer(self):
        from gateway.session_results import finish_result
        from gateway.session_settlement_recovery import completion_payload
        self.submit()
        started = self.claim()
        self.consumer().call('revoke', {})
        captured = {'result': {'final_response': 'must disappear', 'local_viewer': True,
                    'response_transformed': True, 'response_previewed': True, 'last_reasoning': 'private partial'}}
        with patch('gateway.session_settlement_recovery.owner_stop_notice', return_value=None):
            settled, response = finish_result(self.db, epoch=self.authority.epoch, row=started,
                response='must disappear', outcome='interrupted', prepared=('interrupted', captured))
        self.assertEqual(response, '')
        complete = completion_payload(started, settled, response, captured)
        self.assertEqual((complete['text'], complete['content']), ('', ''))
        self.assertNotIn('reasoning', complete)

    def test_unknown_captured_recovery_rechecks_revocation(self):
        from hermes_state_runtime import resolve_unknown_session_input
        from gateway.session_settlement_recovery import completion_payload
        submitted = self.submit()
        started = self.claim()
        # Inject the precise failed-settlement state without replaying inference or changing epoch.
        self.db._execute_write(lambda conn: conn.execute("UPDATE session_admissions SET status='unknown' WHERE admission_id=?",
                                                        (started['admission_id'],)))
        self.consumer().call('revoke', {})
        captured = {'result': {'final_response': 'must disappear', 'local_viewer': True, 'response_transformed': True}}
        settled = resolve_unknown_session_input(self.db, epoch=self.authority.epoch,
            admission_id=started['admission_id'], generation=started['generation'], _captured=('completed', captured))
        self.assertEqual(settled['outcome'], 'interrupted')
        info = self.consumer().call('inspect', {'eventId': 'e1', 'digest': submitted['descriptor']['digest']})
        self.assertEqual(info['receipt']['result']['final_response'], '')
        self.assertEqual(completion_payload(started, settled, 'must disappear', captured)['text'], '')

    def test_revoked_failure_callback_cannot_persist_external_diagnostic(self):
        from gateway.session_results import finish_result
        self.submit()
        started = self.claim()
        self.consumer().call('revoke', {})
        captured = {'result': {'final_response': '', 'failed': True, 'error': 'revoked private diagnostic',
                               'error_surface': {}}}
        with patch('gateway.session_settlement_recovery.owner_stop_notice', return_value=None):
            settled, response = finish_result(self.db, epoch=self.authority.epoch, row=started,
                response='revoked private diagnostic', outcome='failed', result=captured,
                prepared=('failed', captured))
        self.assertEqual((settled['outcome'], response), ('interrupted', ''))
        with self.db._read_ctx() as conn:
            self.assertNotIn('revoked private diagnostic', str([tuple(r) for r in conn.execute('SELECT content FROM messages')]))

    def host_function(self, relative, class_name, name, namespace):
        # Compile the exact pinned, transformed method body without importing gateway.run/bootstrap.
        tree = ast.parse((OVERLAY / relative).read_text(encoding='utf-8'))
        cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == class_name)
        function = next(n for n in cls.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == name)
        exec(compile(ast.Module(body=[function], type_ignores=[]), relative, 'exec'), namespace)
        return namespace[name]

    def test_actual_drain_refuses_stale_head_and_advances_foreground_without_manual_cancel(self):
        from hermes_state_runtime import (RuntimeStoreError, admit_session_input, cancel_session_input,
                                         get_session_admission, list_session_admissions)
        from gateway.session_contract import SessionRef
        self.submit()
        foreground = admit_session_input(self.db, epoch=self.authority.epoch, principal_id='human',
            session_id='original', request_id='human-after-refusal', payload={'text': 'ordinary'})
        self.allowed = False
        ns = {'asyncio': asyncio, 'RuntimeStoreError': RuntimeStoreError, 'partial': partial,
              'get_session_admission': get_session_admission, 'list_session_admissions': list_session_admissions,
              'cancel_session_input': cancel_session_input}
        host = self.authority
        host.cancel_obligations, host.waiters = set(), {}
        host._settle_cancelled = lambda *a: None
        host._pause = lambda *a: self.fail('stale v1 head must be refused, not pause foreground')
        async def claim_next(ref, live):
            first = next((r for r in list_session_admissions(self.db, session_id='original') if r['status'] == 'queued'), None)
            return self.claim(), first
        host._claim_next = claim_next
        refuse = self.host_function('gateway/session_authority.py', 'SessionAuthority', '_refuse_head', ns)
        host._refuse_head = partial(refuse, host)
        retry = self.host_function('gateway/session_authority.py', 'SessionAuthority', '_claim_with_retry', ns)
        with patch('gateway.session_ingress_media.release_admission_media', return_value=None):
            result = asyncio.run(retry(host, SessionRef('fixture-ivy', 'original'), host.sessions['original']))
        self.assertEqual(result[0]['admission_id'], foreground['admission_id'])

    def test_actual_native_dispatch_calls_closed_host_interface(self):
        from gateway.session_contract import SessionRef
        dispatch = self.host_function('gateway/session_controls.py', 'AuthorityConnection', 'dispatch',
                                     {'SessionRef': SessionRef})
        self.connection._operator = False
        reply = asyncio.run(dispatch(self.connection, {'id': 1, 'method': 'stellar.background.inspect',
            'params': {'session_id': 'original', 'bindingId': self.binding['bindingId'], 'eventId': 'absent', 'digest': 'c' * 64}}))
        self.assertEqual(reply['result']['status'], 'unknown')

    def test_second_transport_cannot_release_first_transport_effect_custody(self):
        submitted = self.submit()
        self.complete()
        params = {'eventId': 'e1', 'digest': submitted['descriptor']['digest'], 'operation': 'known-operation', 'kind': 'speech'}
        self.consumer().call('effect.begin', params)
        second = SimpleNamespace(authority=self.authority, subscriptions={'original': 'sub-2'},
                                 actor=replace(self.connection.actor, transport_id='second-native-transport'))
        self.authority.events[second.actor.transport_id] = object()
        self.authority._native_legacy_transports[second.actor.transport_id] = second.actor
        self.host.verify_native = lambda c: c is self.connection or c is second
        other = self.host.consumer(second, 'original', self.binding['bindingId'])
        self.assertCode('effect_owner_mismatch', lambda: other.call('effect.finish', {k: v for k, v in params.items() if k != 'digest'}))
        self.assertCode('effect_already_claimed', lambda: other.call('effect.begin', params))
        self.assertFalse(other.call('revoke', {})['effectsStopped'])

    def test_artifact_version_cannot_reuse_old_worker_incarnation(self):
        self.host.unregister_producer(self.producer)
        self.assertCode('producer_identity_conflict', lambda: self.host.register_producer('stellar-herdr',
                        version='updated-artifact', incarnation='a' * 32))

    def test_partial_source_or_stale_loaded_code_refuses_composition(self):
        import hermes_state_runtime as runtime
        from stellar_background.provenance import verify_candidate
        path = OVERLAY / 'gateway/session_controls.py'
        saved = path.read_bytes()
        try:
            path.write_bytes(saved + b'\n# unknown later edit\n')
            self.assertCode('runtime_mismatch', lambda: verify_candidate(OVERLAY))
        finally:
            path.write_bytes(saved)
        with patch.object(runtime, 'claim_session_input', lambda *a, **k: None):
            self.assertCode('loaded_runtime_mismatch', lambda: verify_candidate(OVERLAY))

    def test_incomplete_rollback_manifest_refuses_before_any_write(self):
        from stellar_background.overlay import undo_fixture
        missing = {**MANIFEST, 'files': dict(list(MANIFEST['files'].items())[1:])}
        self.assertCode('rollback_mismatch', lambda: undo_fixture(RUNTIME, OVERLAY, missing))

    def test_public_plugin_context_exposes_only_its_profile_and_plugin_port(self):
        from hermes_cli.plugins_context import PluginContext
        from hermes_constants import hermes_home_key
        ctx = object.__new__(PluginContext)
        ctx.manifest = SimpleNamespace(key='stellar-herdr', name='stellar-herdr')
        ctx._manager = SimpleNamespace(scope_key=hermes_home_key('fixture-ivy'))
        self.assertIsNone(ctx.background_v1)
        self.host.expose(ctx._manager, self.producer)
        self.assertIs(ctx.background_v1, self.producer)
        self.host.unregister_producer(self.producer)
        self.assertIsNone(ctx.background_v1)
        replacement = self.host.register_producer('stellar-herdr', version='fixture-v1', incarnation='d' * 32)
        self.host.expose(ctx._manager, replacement)
        self.assertIs(ctx.background_v1, replacement)
        ctx.manifest = SimpleNamespace(key='other-plugin', name='other-plugin')
        self.assertIsNone(ctx.background_v1)
        self.assertCode('permission_denied', lambda: self.host.expose(SimpleNamespace(scope_key='other-profile'), replacement))

    def test_disable_retains_effect_fences_and_denies_queued_work(self):
        submitted = self.submit()
        self.complete()
        self.consumer().call('effect.begin', {'eventId': 'e1', 'digest': submitted['descriptor']['digest'],
                                             'operation': 'pending-speech', 'kind': 'speech'})
        self.submit('queued')
        disabled = self.host.detach()
        self.assertEqual(disabled[self.binding['bindingId']]['status'], 'revoking')
        self.assertFalse(disabled[self.binding['bindingId']]['effectsStopped'])
        self.assertIsNone(self.claim())

    def test_live_replay_and_prompt_receipt_preserve_identical_descriptor(self):
        from dataclasses import asdict
        from gateway.session_automation import admission_display
        from gateway.session_contract import SessionRef, AdmissionReceipt
        from gateway.session_events import SessionEvents
        from stellar_background.wiring import receipt
        from tui_gateway.contracts.events import MessageStartPayload
        from tui_gateway.contracts.canonical import PromptReceiptResult
        submitted = self.submit()
        row = self.complete()
        live = admission_display(row['payload'])
        stream, frames = SessionEvents(), []
        stream.observers.add(lambda frame: frames.append(json.loads(json.dumps(frame))))
        self.authority.executing = {}
        self.authority.sessions['original'].event_stream = stream
        stamp = self.host_function('gateway/session_authority.py', 'SessionAuthority', '_stamp_claim', {})
        stamp(self.authority, SessionRef('fixture-ivy', 'original'), self.authority.sessions['original'], row)
        caught = stream.since(stream.epoch, 0)
        self.assertFalse(caught['snapshot_required'])
        replay = caught['events'][0]['payload']
        self.assertEqual(live['background_v1'], submitted['descriptor'])
        self.assertEqual(replay, live)
        self.assertEqual(caught['events'][0]['admission_id'], row['admission_id'])
        self.assertEqual(frames[0]['params']['payload'], live)
        tail = []
        stream.catch_up(SimpleNamespace(write=lambda frame: tail.append(frame)), stream.epoch, 0)
        self.assertEqual(tail[0]['params']['payload'], live)
        MessageStartPayload.model_validate(live)
        info = self.consumer().call('inspect', {'eventId': 'e1', 'digest': submitted['descriptor']['digest']})
        out = receipt(self.connection, SessionRef('fixture-ivy', 'original'), row['admission_id'], info['receipt'])
        self.assertTrue(out['background_delivery_authorized'])
        self.assertEqual(out['background_v1'], live['background_v1'])
        PromptReceiptResult.model_validate(out)
        async def canonical_receipt(actor, ref, admission_id):
            self.authority.authorize(actor, ref, 'session:control')
            return AdmissionReceipt(**{k: (ref if k == 'ref' else v) for k, v in info['receipt'].items() if k != 'result'})
        self.authority.receipt = canonical_receipt
        projected = self.host_function('gateway/session_controls.py', 'AuthorityConnection', 'receipt', {'asdict': asdict})
        actual = asyncio.run(projected(self.connection, SessionRef('fixture-ivy', 'original'),
                                      {'admission_id': row['admission_id'], 'include_result': True}))
        self.assertEqual(actual['background_v1'], live['background_v1'])
        self.assertEqual(actual['result']['final_response'], 'fixture answer')
        PromptReceiptResult.model_validate(actual)
        settling = receipt(self.connection, SessionRef('fixture-ivy', 'original'), row['admission_id'],
                           {**info['receipt'], 'status': 'started'})
        self.assertFalse(settling['background_delivery_authorized'])
        begin_params = {'eventId': 'e1', 'digest': submitted['descriptor']['digest'],
                        'operation': 'durably-saved-render-operation', 'kind': 'render'}
        begin = self.consumer().call('effect.begin', begin_params)
        duplicate = self.consumer().call('effect.begin', begin_params)
        revoked = self.consumer().call('revoke', {})
        finished = self.consumer().call('effect.finish', {k: v for k, v in begin_params.items() if k != 'digest'})
        EXAMPLES.update(binding=self.binding, producerEvent=self.event(), submit=submitted,
            live=frames[0], replay=caught, promptReceipt=actual, inspect=info,
            effectBegin={'params': begin_params, 'result': begin}, exactEffectRetry=duplicate,
            revoke=revoked, effectFinish=finished)
        stream.release()

    def test_consumer_effect_custody_reconnect_and_revoke(self):
        submitted = self.submit()
        self.complete()
        params = {'eventId': 'e1', 'digest': submitted['descriptor']['digest'], 'operation': 'durable-op', 'kind': 'speech'}
        self.assertTrue(self.consumer().call('effect.begin', params)['execute'])
        self.assertFalse(self.consumer().call('effect.begin', params)['execute'])
        revoked = self.consumer().call('revoke', {})
        self.assertEqual(revoked['status'], 'revoking')
        self.assertFalse(revoked['effectsStopped'])
        ack = self.consumer().call('effect.finish', {k: v for k, v in params.items() if k != 'digest'})
        self.assertTrue(ack['effectsStopped'])
        self.assertCode('invalid_params', lambda: self.consumer().call('effect.begin', {**params, 'client': 'forged'}))

    def test_host_rpc_closed_arguments_and_no_grant_minting_method(self):
        from stellar_background.wiring import dispatch
        def call(method, params):
            return asyncio.run(dispatch(self.connection, {'id': 7, 'method': 'stellar.background.' + method, 'params': params}))
        base = {'session_id': 'original', 'bindingId': self.binding['bindingId']}
        out = call('inspect', {**base, 'eventId': 'absent', 'digest': 'a' * 64})
        self.assertEqual(out['result']['status'], 'unknown')
        self.assertFalse(out['result']['retryAuthorized'])
        for method, params in [('approve', base), ('submit', base), ('revoke', {**base, 'profile': 'other'}),
                               ('revoke', {**base, 'client': 'forged'}), ('bind', {**base, 'origin': {}})]:
            self.assertIn('error', call(method, params))

    def test_producer_unregister_and_wrong_owner_do_not_grant_delivery(self):
        submitted = self.submit()
        self.complete()
        self.connection.actor = replace(self.connection.actor, subject='impostor')
        self.assertCode('permission_denied', self.consumer)
        self.connection.actor = self.authority._native_legacy_transports['transport']
        self.host.unregister_producer(self.producer)
        info = self.consumer().call('inspect', {'eventId': 'e1', 'digest': submitted['descriptor']['digest']})
        self.assertFalse(info['deliveryAuthorized'])
        self.assertCode('producer_unavailable', lambda: self.producer.inspect(self.binding['bindingId'], 'e1', submitted['descriptor']['digest']))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime', type=Path, required=True)
    parser.add_argument('--evidence', type=Path)
    args, rest = parser.parse_known_args()
    RUNTIME = args.runtime
    sys.dont_write_bytecode = True
    candidate = REPO / 'config/hermes-compat/stellar-background-v1'
    sys.path[:0] = [str(candidate), str(args.runtime.resolve())]
    with tempfile.TemporaryDirectory(prefix='stellar339-overlay-') as directory, tempfile.TemporaryDirectory(prefix='stellar339-host-home-') as home:
        for key in ('HERMES_HOME', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA'):
            os.environ[key] = home
        def offline(event, arguments):
            if event == 'socket.connect' and isinstance(arguments[1], tuple) and arguments[1][0] in ('127.0.0.1', '::1', 'localhost'):
                return  # Windows asyncio creates its own loopback self-pipe.
            if event in ('socket.connect', 'subprocess.Popen', 'os.system', 'os.exec'):
                raise RuntimeError('Network/process launch prohibited in host-port qualification')
        sys.addaudithook(offline)
        from stellar_background.overlay import fixture, undo_fixture
        overlay = Path(directory)
        OVERLAY = overlay
        manifest = fixture(args.runtime, overlay)
        MANIFEST = manifest
        class Copies(importlib.abc.MetaPathFinder):
            def find_spec(self, fullname, path=None, target=None):
                if fullname == 'hermes_bootstrap':
                    raise RuntimeError('Bootstrap prohibited in isolated host-port qualification')
                name = fullname.replace('.', '/') + '.py'
                if name in manifest['files']:
                    return importlib.util.spec_from_file_location(fullname, overlay / name)
                return None
        finder = Copies()
        sys.meta_path.insert(0, finder)
        result = unittest.main(argv=[sys.argv[0], *rest], verbosity=2, exit=False).result
        sys.meta_path.remove(finder)
        restored = undo_fixture(args.runtime, overlay, manifest)
        assert restored['installedCapability'] is False
        print('Pinned source fixture removal: byte-identical base restored; no capability installed.')
        if args.evidence:
            output = args.evidence.resolve()
            if not output.is_relative_to(REPO / 'artifacts/issue-339'):
                raise ValueError('evidence must remain in artifacts/issue-339')
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps({'schemaVersion': 1, 'syntheticContext': True,
                'liveIvyOrModelUsed': False, 'installedCapability': False, 'testsRun': result.testsRun,
                'passed': result.wasSuccessful(), 'fixtureRestored': restored, 'examples': EXAMPLES,
                'patch': manifest}, indent=2) + '\n', encoding='utf-8')
        sys.exit(not result.wasSuccessful())
