"""Fake-clock lifecycle tests through the real bridge dispatcher, no live runtime."""
import asyncio
import copy
import contextlib
import json
from pathlib import Path
import re
import subprocess
import sys
import types
import unittest
from unittest.mock import patch

from tools.native.ivy_bridge_test import bridge, Connection, Pipe
import stellar_ivy_controls as control_module
from stellar_ivy_controls import Refused
from stellar_ivy_reconcile import Reconciler, METHOD, summary

REPLY = {'reconciled': 1, 'delivery': 'notification_admission_only',
         'notifications': {'known': 0, 'unknown': 1, 'suppressed': 0}}


async def drain():
    for _ in range(30):
        await asyncio.sleep(0)


class Clock:
    def __init__(self):
        self.now, self.sleepers = 0, []

    async def sleep(self, delay):
        future = asyncio.get_running_loop().create_future()
        item = (self.now + delay, future)
        self.sleepers.append(item)
        try:
            await future
        finally:
            self.sleepers.remove(item)

    async def advance(self, seconds):
        await drain()
        self.now += seconds
        for due, future in list(self.sleepers):
            if due <= self.now and not future.done():
                future.set_result(None)
        await drain()


class GatewayError(Exception):
    pass


class ReconcileTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.owners = []
        controls = patch.dict(sys.modules, {'stellar_ivy_controls': control_module})
        controls.start()
        self.addCleanup(controls.stop)

    async def asyncTearDown(self):
        for owner in self.owners:
            await owner.close()

    def fixture(self, sid='original', deadline=15):
        conn, clock = Connection(), Clock()
        conn.selected_session = sid
        conn.rpc_error_type = GatewayError
        conn.active = {'session_id': sid, 'admission_id': 'foreground'}
        conn.rpc_calls = []
        async def rpc(method, **params):
            conn.rpc_calls.append((method, params))
            return copy.deepcopy(REPLY)
        conn.rpc = rpc
        original_call = conn.call
        async def call(method, params):
            if method == 'session.resume':
                conn.sessions.add(params['session_id'])
                return {'session_id': params['session_id']}
            return await original_call(method, params)
        conn.call = call
        owner = conn.notification_reconciler = Reconciler(conn, deadline,
            lambda error: bridge.failure_diagnostic(conn, error), clock=lambda: clock.now, sleep=clock.sleep)
        owner.select(sid)
        self.owners.append(owner)
        return conn, clock, owner

    async def dispatch(self, conn, method, params):
        queue, output = asyncio.Queue(), Pipe()
        await queue.put(bridge.validate({'id': 1, 'method': method, 'params': params}))
        await queue.put(None)
        with patch.object(sys, 'stdout', output):
            await bridge.request_worker(conn, None, queue)
        return json.loads(output.buffer.getvalue())

    async def test_private_forwarding_uses_exact_authenticated_rpc_and_only_count_summary(self):
        conn, clock, _ = self.fixture()
        await clock.advance(60)
        reply = await self.dispatch(conn, 'stellar.notification.reconcile', {'session_id': 'original'})
        self.assertEqual(reply, {'id': 1, 'result': REPLY})
        self.assertEqual(conn.rpc_calls, [(METHOD, {'session_id': 'original'})])
        for params in [{'session_id': 'foreign'}, {'session_id': 'original', 'event_id': 'old-UNKNOWN'}]:
            if 'event_id' in params:
                with self.assertRaises(ValueError):
                    await self.dispatch(conn, 'stellar.notification.reconcile', params)
            else:
                self.assertEqual((await self.dispatch(conn, 'stellar.notification.reconcile', params))['error']['code'], 'unavailable')
        self.assertEqual(len(conn.rpc_calls), 1)
        self.assertEqual(conn.active['admission_id'], 'foreground')
        self.assertEqual(conn.lease.released, [])
        self.assertFalse(conn.completed)

    async def test_idle_and_busy_foreground_tick_without_prompt_lease_or_approval_effect(self):
        for busy in (False, True):
            conn, clock, owner = self.fixture()
            conn.active = {'session_id': 'original', 'admission_id': 'old-UNKNOWN'} if busy else None
            before = copy.deepcopy(conn.active)
            asyncio.create_task(owner.run())
            await clock.advance(59)
            self.assertEqual(conn.rpc_calls, [])
            await clock.advance(1)
            self.assertEqual(conn.rpc_calls, [(METHOD, {'session_id': 'original'})])
            await clock.advance(60)
            self.assertEqual(len(conn.rpc_calls), 2)
            self.assertEqual(conn.active, before)
            self.assertEqual(conn.calls, [])
            self.assertEqual(conn.lease.released, [])
            self.assertFalse(conn.completed)
            await owner.close()

    async def test_slow_reconcile_manual_race_and_duplicate_tick_have_one_nonqueued_owner(self):
        conn, clock, owner = self.fixture()
        release = asyncio.Event()
        async def rpc(method, **params):
            conn.rpc_calls.append((method, params))
            await release.wait()
            return REPLY
        conn.rpc = rpc
        asyncio.create_task(owner.run())
        await clock.advance(60)
        self.assertTrue(owner.busy)
        reply = await self.dispatch(conn, 'stellar.notification.reconcile', {'session_id': 'original'})
        self.assertEqual(reply['error']['code'], 'busy')
        self.assertEqual((await self.dispatch(conn, 'ping', {}))['result'], {'pong': True})
        await clock.advance(600)
        self.assertEqual(len(conn.rpc_calls), 1)
        release.set()
        await drain()
        await clock.advance(59)
        self.assertEqual(len(conn.rpc_calls), 1)
        await clock.advance(1)
        self.assertEqual(len(conn.rpc_calls), 2)
        with self.assertRaisesRegex(RuntimeError, 'notification_reconcile_owner'):
            await owner.run()

    async def test_revoke_invalidates_held_result_without_canceling_or_releasing_the_gate(self):
        data = json.loads((Path(__file__).parent / 'evidence/stellar-herdr-notification-forward-v1.json').read_text(encoding='utf-8'))
        sid = data['binding']['owner_session_id']
        conn, clock, owner = self.fixture(sid)
        release, done = asyncio.Event(), asyncio.Event()
        async def rpc(method, **params):
            conn.rpc_calls.append((method, params))
            await release.wait()
            done.set()
            return REPLY
        conn.rpc = rpc
        await clock.advance(60)
        pending = asyncio.create_task(owner.forward({'session_id': sid}))
        await drain()
        generation = owner.generation
        await conn.events.put(data['raw_revoke'])
        await conn.events.put(RuntimeError('end fixture events'))
        with patch.object(bridge, 'PROFILE', data['binding']['profile_id']), patch.object(sys, 'stdout', Pipe()), self.assertRaises(bridge.Closed):
            await bridge.pump_events(conn, None, None)
        self.assertGreater(owner.generation, generation)
        self.assertTrue(owner.busy)
        self.assertFalse(done.is_set())
        await clock.advance(60)
        self.assertEqual((await self.dispatch(conn, 'stellar.notification.reconcile', {'session_id':sid}))['error']['code'], 'busy')
        release.set()
        with self.assertRaises(Refused) as refused:
            await pending
        self.assertEqual(refused.exception.code, 'unavailable')
        self.assertEqual(owner.next_due, clock.now + 60)
        self.assertEqual(conn.active['admission_id'], 'foreground')
        self.assertEqual(conn.lease.released, [])

    async def test_session_switch_pauses_before_await_and_never_retargets_old_inflight_call(self):
        conn, clock, owner = self.fixture()
        release = asyncio.Event()
        async def rpc(method, **params):
            conn.rpc_calls.append((method, params))
            await release.wait()
            return REPLY
        conn.rpc = rpc
        await clock.advance(60)
        pending = asyncio.create_task(owner.forward({'session_id':'original'}))
        await drain()
        await self.dispatch(conn, 'session.resume', {'session_id':'replacement'})
        self.assertEqual(owner.session, 'replacement')
        self.assertTrue(owner.busy)
        release.set()
        with self.assertRaises(Refused):
            await pending
        self.assertEqual(conn.rpc_calls, [(METHOD, {'session_id':'original'})])
        asyncio.create_task(owner.run())
        await clock.advance(60)
        self.assertEqual(conn.rpc_calls[-1], (METHOD, {'session_id':'replacement'}))

    async def test_unannounced_original_session_or_client_change_refuses_dispatch(self):
        for field, value in [('selected_session','foreign'), ('client',object())]:
            conn, clock, owner = self.fixture()
            asyncio.create_task(owner.run())
            setattr(conn, field, value)
            await clock.advance(120)
            self.assertEqual(conn.rpc_calls, [])
            await owner.close()

    async def test_completed_unavailable_error_keeps_foreground_usable_and_rechecks_after_60(self):
        conn, clock, owner = self.fixture()
        async def rpc(method, **params):
            conn.rpc_calls.append((method, params))
            if len(conn.rpc_calls) == 1:
                raise GatewayError('method_not_found')
            return REPLY
        conn.rpc = rpc
        asyncio.create_task(owner.run())
        await clock.advance(60)
        self.assertFalse(owner.suspended)
        self.assertEqual(owner.last_error, 'owner_other')
        self.assertEqual((await self.dispatch(conn, 'ping', {}))['result'], {'pong':True})
        await clock.advance(59)
        self.assertEqual(len(conn.rpc_calls), 1)
        await clock.advance(1)
        self.assertEqual(len(conn.rpc_calls), 2)
        self.assertIsNone(owner.last_error)
        self.assertEqual(conn.lease.released, [])

    async def test_timeout_transport_and_malformed_suspend_until_explicit_resume(self):
        for failure in ('timeout','transport','malformed'):
            conn, clock, owner = self.fixture(deadline=0.01)
            async def rpc(method, **params):
                conn.rpc_calls.append((method,params))
                if failure=='timeout':
                    await asyncio.Event().wait()
                if failure=='transport':
                    raise RuntimeError('private token or path')
                return {**REPLY,'reconciled':True}
            conn.rpc = rpc
            await clock.advance(60)
            reply = await self.dispatch(conn,'stellar.notification.reconcile',{'session_id':'original'})
            self.assertEqual(reply['error']['code'],'outcome_uncertain')
            self.assertTrue(owner.suspended)
            asyncio.create_task(owner.run())
            await clock.advance(600)
            self.assertEqual(len(conn.rpc_calls),1)
            self.assertEqual((await self.dispatch(conn,'ping',{}))['result'],{'pong':True})
            await self.dispatch(conn,'session.resume',{'session_id':'original'})
            self.assertFalse(owner.suspended)
            self.assertEqual(owner.next_due,clock.now+60)
            self.assertEqual(conn.lease.released,[])
            await owner.close()

    async def test_disconnect_cancels_local_timer_unknown_and_reconnect_gets_fresh_interval(self):
        conn, clock, owner = self.fixture()
        async def rpc(method, **params):
            conn.rpc_calls.append((method,params))
            await asyncio.Event().wait()
        conn.rpc=rpc
        asyncio.create_task(owner.run())
        await clock.advance(60)
        await owner.close()
        self.assertTrue(owner.closed and owner.suspended and owner.runner.done())
        owner.select('original')
        await clock.advance(600)
        self.assertEqual(len(conn.rpc_calls),1)
        fresh, clock2, second = self.fixture()
        asyncio.create_task(second.run())
        await clock2.advance(59)
        self.assertEqual(fresh.rpc_calls,[])
        await clock2.advance(1)
        self.assertEqual(fresh.rpc_calls,[(METHOD,{'session_id':'original'})])

    async def test_real_serve_eof_is_success_and_finishes_scheduler_and_children(self):
        created = []
        class Owner(Reconciler):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                created.append(self)
        client = Connection()
        def connection(peer, **_kwargs):
            conn=Connection()
            conn.client=peer
            return conn
        @contextlib.asynccontextmanager
        async def connect(_endpoint):
            yield client
        endpoint=types.SimpleNamespace(runtime_protocol=1)
        workspace_modules={
            'stellar_workspace_credentials':types.SimpleNamespace(WorkspaceCredentials=object),
            'stellar_workspace_protocol':types.SimpleNamespace(WorkspaceGate=object),
            'stellar_workspace_mcp':types.SimpleNamespace(make_server=None),
            'stellar_workspace_service':types.SimpleNamespace(WorkspaceService=object),
            'stellar_ivy_approvals':types.SimpleNamespace(Approvals=object,load_access=lambda _:{ }),
            'hermes_cli':types.ModuleType('hermes_cli'),
            'hermes_cli.gateway_client':types.SimpleNamespace(GatewayRPCError=GatewayError),
            'win32cred':None,
        }
        def discover(*_args, **_kwargs):
            return types.SimpleNamespace(state='ready',endpoint=endpoint)
        with patch.dict(sys.modules,workspace_modules), patch.object(bridge,'load_library',return_value=(connection,discover,connect)), patch.object(sys,'stdin',Pipe()), patch.object(sys,'stdout',Pipe()), patch.object(sys.modules['stellar_ivy_voice_expression'],'installed',return_value=False), patch.object(sys.modules['stellar_ivy_reconcile'],'Reconciler',Owner):
            self.assertEqual(await bridge.serve(),0)
        self.assertEqual(len(created),1)
        self.assertTrue(created[0].closed)
        self.assertTrue(created[0].runner.done())

    def test_actual_native_embedded_module_assembly_imports_without_entrypoint_or_installed_runtime(self):
        folder=Path(__file__).resolve().parents[2]/'apps/stellar-desktop/src-tauri/src/ivy'
        modules=re.findall(r'"(stellar_[a-z_]+)"\s*,\s*include_str!\("([a-z_]+\.py)"\)',(folder/'process.rs').read_text(encoding='utf-8'))
        self.assertIn(('stellar_ivy_reconcile','ivy_reconcile.py'),modules)
        program=['import sys,types,contextlib\nsys.dont_write_bytecode=True']
        for name,file in modules:
            source=json.dumps((folder/file).read_text(encoding='utf-8'))
            program.append(f"_m=types.ModuleType('{name}');sys.modules['{name}']=_m\nwith contextlib.redirect_stdout(sys.stderr):\n exec({source},_m.__dict__)")
        program.append("assert 'stellar_ivy_reconcile' in sys.modules")
        result=subprocess.run([sys.executable,'-I','-c','import sys;exec(sys.stdin.read())'],input='\n'.join(program),text=True,capture_output=True,timeout=10)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(result.stdout,'')

    def test_summary_is_closed_bounded_and_never_delivery_evidence(self):
        for bad in [None, {**REPLY,'reconciled':True}, {**REPLY,'extra':'text'},
                    {**REPLY,'notifications':{'known':4,'unknown':1,'suppressed':0}},
                    {**REPLY,'notifications':{'known':False,'unknown':0,'suppressed':0}},
                    {**REPLY,'notifications':{'known':-1,'unknown':0,'suppressed':0}}]:
            with self.assertRaises(ValueError):
                summary(bad)


if __name__ == '__main__':
    unittest.main()
