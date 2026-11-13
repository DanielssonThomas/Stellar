"""Real assembled consumer timer -> authenticated producer RPC/store, fake clock/inference."""
import asyncio
from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import sys
from unittest.mock import patch

import pytest

from tests.gateway import test_observer_notification_composition as observer

runtime_owner = observer.runtime_owner
composed = observer.composed


async def drain():
    for _ in range(30):
        await asyncio.sleep(0)


class Clock:
    def __init__(self, producer_clock):
        self.now, self.sleepers = 0, []
        self.producer_clock = producer_clock

    async def sleep(self, delay):
        pending = asyncio.get_running_loop().create_future()
        item = (self.now + delay, pending)
        self.sleepers.append(item)
        try:
            await pending
        finally:
            self.sleepers.remove(item)

    async def advance(self, seconds):
        await drain()
        self.now += seconds
        self.producer_clock.now += seconds
        for due, pending in list(self.sleepers):
            if due <= self.now and not pending.done():
                pending.set_result(None)
        await drain()


class GatewayError(Exception):
    pass


def bridge_fixture():
    path = Path(observer.CONFIG['consumer_source']) / 'tools/native/ivy_bridge_test.py'
    spec = importlib.util.spec_from_file_location('assembled_timer_bridge_fixture', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Client:
    """In-process JSON-RPC transport to the existing authenticated real test server."""
    def __init__(self, server):
        self.server, self.calls, self.results = server, [], asyncio.Queue()

    async def rpc(self, method, **params):
        assert method in {'session.resume', 'plugin.stellar-herdr.observations.reconcile',
                          'plugin.stellar-herdr.observations.inspect'}
        self.calls.append((method, deepcopy(params)))
        reply = await self.server.dispatch({'id': len(self.calls), 'method': method, 'params': params})
        if 'error' in reply:
            raise GatewayError(reply['error'])
        if method.endswith('.reconcile'):
            await self.results.put(deepcopy(reply['result']))
        return reply['result']


async def dispatch(fixture, conn, method, params):
    queue, output = asyncio.Queue(), fixture.Pipe()
    await queue.put(fixture.bridge.validate({'id': 1, 'method': method, 'params': params}))
    await queue.put(None)
    with patch.object(sys, 'stdout', output):
        await fixture.bridge.request_worker(conn, None, queue)
    return json.loads(output.buffer.getvalue())


async def attach(c, fixture, clock, busy=False):
    conn = fixture.Connection()
    client = Client(c.connection)
    client.events = conn.events
    conn.client, conn.call, conn.rpc_error_type = client, lambda method, params: client.rpc(method, **params), GatewayError
    conn.active = {'session_id': c.owner.ref.session_id, 'admission_id': 'fixture-old-UNKNOWN'} if busy else None
    owner = sys.modules['stellar_ivy_reconcile'].Reconciler(conn, fixture.bridge.DEADLINE,
        lambda error: fixture.bridge.failure_diagnostic(conn, error), clock=lambda: clock.now, sleep=clock.sleep)
    conn.notification_reconciler = owner
    resumed = await dispatch(fixture, conn, 'session.resume', {'session_id': c.owner.ref.session_id})
    assert resumed['result']['session_id'] == c.owner.ref.session_id, resumed
    assert owner.session == c.owner.ref.session_id
    asyncio.create_task(owner.run())
    await drain()
    return conn, client, owner


@pytest.mark.asyncio
@pytest.mark.parametrize('busy', [False, True])
async def test_assembled_timer_to_canonical_inspection_and_consumer_projection(composed, monkeypatch, busy):
    c, fixture = composed, bridge_fixture()
    monkeypatch.setattr(fixture.bridge, 'PROFILE', c.owner.home)
    enabled = await c.enable()
    clock = Clock(c.clock)
    conn, client, owner = await attach(c, fixture, clock, busy)
    foreground = deepcopy(conn.active)
    try:
        c.state.finished = True
        await clock.advance(59)
        assert client.results.empty() and c.state.host_calls.count('admit') == 0
        await clock.advance(2)
        result = await asyncio.wait_for(client.results.get(), 15)
        await drain()
        assert result == {'reconciled': 1, 'delivery': 'notification_admission_only',
                          'notifications': {'known': 1, 'unknown': 0, 'suppressed': 0}}
        assert c.state.host_calls.count('admit') == 1
        await c.owner.authority._drain(c.owner.ref)
        event_id = c.event_id()
        start = next(frame for frame in c.state.frames if frame['params']['type'] == 'message.start')
        terminal = next(frame for frame in c.state.frames if frame['params']['type'] == 'message.complete')
        stamp = start['params']
        inspected = await dispatch(fixture, conn, 'stellar.notification.inspect', {
            'session_id': c.owner.ref.session_id, 'admission_id': stamp['admission_id'],
            'descriptor': stamp['payload']['plugin_notification']})
        assert inspected['result']['delivery_allowed'] is True, inspected
        assert inspected['result']['host']['receipt']['admission_id'] == stamp['admission_id']
        assert inspected['result']['host']['result']['result']['final_response'].startswith('Fixture:')
        raw_receipt = await c.connection.dispatch({'id': 2, 'method': 'prompt.receipt', 'params': {
            'session_id': c.owner.ref.session_id, 'admission_id': stamp['admission_id']}})
        await clock.advance(60)
        await asyncio.wait_for(client.results.get(), 15)
        assert c.state.host_calls.count('admit') == 1
        revoked = await c.rpc('revoke', {'event_id': event_id})
        assert revoked['result']['state'] == 'revoked'
        revocation = next(frame for frame in c.state.frames if
                          frame['params']['type'] == 'plugin.stellar-herdr.notification.revoked')
        for frame in [start, terminal, revocation]:
            await conn.events.put(deepcopy(frame))
        await conn.events.put(RuntimeError('end fixture event stream'))
        projected = fixture.Pipe()
        with patch.object(sys, 'stdout', projected), pytest.raises(fixture.bridge.Closed):
            await fixture.bridge.pump_events(conn, None, None)
        frames = [json.loads(row) for row in projected.buffer.getvalue().splitlines()]
        assert len(frames) == 3
        assert frames[0]['data']['params']['payload']['plugin_notification'] == stamp['payload']['plugin_notification']
        assert conn.active == foreground and conn.lease.released == [] and not conn.completed
        assert not any(method == 'prompt.submit' for method, _ in client.calls)
        if not busy:
            proof = {'fixture': True, 'inference': 'fake; no provider call', 'composition': observer.CONFIG,
                'binding': enabled['binding'], 'event_id': event_id, 'raw_start': start,
                'raw_terminal': terminal, 'raw_revoke': revocation, 'raw_events': c.state.frames,
                'canonical_receipt_rpc': raw_receipt, 'producer_inspection_rpc': inspected,
                'consumer_frames': frames, 'timer_rpc_calls': client.calls,
                'actual_timer_to_authenticated_producer': True, 'fake_clock_seconds': clock.now}
            (observer.COMPOSITION / 'timer-host-consumer-frames.json').write_text(json.dumps(proof, indent=2) + '\n', encoding='utf-8')
    finally:
        await owner.close()


@pytest.mark.asyncio
async def test_assembled_timer_optout_before_first_tick_never_admits(composed, monkeypatch):
    c, fixture = composed, bridge_fixture()
    monkeypatch.setattr(fixture.bridge, 'PROFILE', c.owner.home)
    await c.enable()
    clock = Clock(c.clock)
    conn, client, owner = await attach(c, fixture, clock)
    try:
        c.state.finished = True
        assert (await c.tool({'action': 'tracking', 'issue': 23, 'enabled': False}))['tracking'] is False
        await clock.advance(61)
        result = await asyncio.wait_for(client.results.get(), 15)
        assert result['notifications'] == {'known': 0, 'unknown': 0, 'suppressed': 0}
        assert c.state.host_calls.count('admit') == 0
        assert c.state.inference == [] and conn.lease.released == []
    finally:
        await owner.close()


@pytest.mark.asyncio
async def test_assembled_timer_reconnect_inspects_lost_ack_without_resending(composed, monkeypatch):
    c, fixture = composed, bridge_fixture()
    monkeypatch.setattr(fixture.bridge, 'PROFILE', c.owner.home)
    await c.enable()
    async def lost(action, **params):
        result = await c.original_notification(action, **params)
        if action == 'admit':
            raise OSError('fixture lost admission ACK after actual commit')
        return result
    monkeypatch.setattr(c.producer.ctx, 'notification', lost)
    clock = Clock(c.clock)
    conn, client, first = await attach(c, fixture, clock)
    second = None
    try:
        c.state.finished = True
        await clock.advance(61)
        result = await asyncio.wait_for(client.results.get(), 15)
        assert result['notifications']['unknown'] == 1
        event_id = c.event_id()
        assert c.producer.store()[0].lookup(event_id)['phase'] == 'unknown'
        await first.close()
        _, reconnected, second = await attach(c, fixture, clock)
        await clock.advance(59)
        assert reconnected.results.empty()
        await clock.advance(1)
        result = await asyncio.wait_for(reconnected.results.get(), 15)
        assert result['notifications']['known'] == 1
        assert c.event_id() == event_id and c.state.host_calls.count('admit') == 1
        assert c.producer.store()[0].lookup(event_id)['phase'] == 'known'
        assert conn.lease.released == []
    finally:
        await first.close()
        if second is not None:
            await second.close()
