"""Disposable real observer->candidate admission/RPC/events; fake source transports/inference only."""
import asyncio
from copy import deepcopy
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import sys
import threading
import time
from types import SimpleNamespace

import pytest
import pytest_asyncio

from tests.gateway import test_plugin_notifications as runtime_fixtures

runtime_owner = runtime_fixtures.owner

COMPOSITION = Path(__file__).resolve().parents[3]
CONFIG = json.loads((COMPOSITION / 'composition-config.json').read_text())


@pytest_asyncio.fixture
async def composed(runtime_owner, monkeypatch):
    from gateway.session_controls import AuthorityConnection
    from hermes_cli import plugins

    owner = runtime_owner
    home = owner.home
    plugin = home / 'plugins/stellar-herdr'
    shutil.copytree(CONFIG['observer_source'], plugin)
    (home / 'config.yaml').write_text(json.dumps({'plugins': {
        'enabled': ['fixture-notifier', 'stellar-herdr'], 'entries': {
            'fixture-notifier': {'allow_gateway_injection': True},
            'stellar-herdr': {'allow_gateway_injection': True}}}}))
    root = home / 'integration/stellar-herdr'
    root.mkdir(parents=True)
    settings = {key: str(home / (key + '.fixture')) for key in ('repo', 'core', 'app', 'hermes', 'node', 'gh', 'git')}
    (root / 'settings.json').write_text(json.dumps(settings))
    receipt = {'schema': 1, 'launch': 'accepted', 'issue': 23, 'role': 'peon-cloud',
        'claim_session': 'fixture-job-23', 'branch': 'issue/23-fix', 'target': 'develop',
        'baseline': 'a'*40, 'incarnation': 'b'*32, 'terminal': 't42'}
    attempt = root / 'attempts' / ('23-' + hashlib.sha256(receipt['claim_session'].encode()).hexdigest())
    attempt.mkdir(parents=True)
    (attempt / 'terminal.json').write_text(json.dumps(receipt))
    owner.manager.discover_and_load(force=True)
    loaded = owner.manager._plugins['stellar-herdr']
    assert loaded.error is None
    package = loaded.module
    producer = owner.manager._plugin_rpc_methods['plugin.stellar-herdr.observations.reconcile'].__self__
    clock = SimpleNamespace(now=time.time())
    producer.clock = lambda: clock.now
    source = sys.modules[package.__name__ + '.observation_sources']
    core = sys.modules[package.__name__ + '.core']
    state = SimpleNamespace(finished=False, commands=[], host_calls=[], frames=[], inference=[])

    def command(argv, **_kwargs):
        state.commands.append(list(argv))
        if len(argv) > 1 and argv[1] == 'tools/policy/manage-issue-worktree.mjs':
            return {'issue': 23, 'worker': 'worker:peon-cloud', 'sessionId': receipt['claim_session'],
                    'branch': receipt['branch'], 'target': receipt['target'], 'state': 'active',
                    'expiresAt': '2099-01-01T00:00:00Z'}
        if len(argv) > 1 and argv[1] == 'get':
            return {'labels': {'stellar-delegate': 'ivy', 'issue': '23', 'role': 'peon-cloud',
                               'stellar-launch': receipt['incarnation']},
                    'state': 'finished' if state.finished else 'live',
                    'exit_code': 0 if state.finished else None, 'status': 'done' if state.finished else 'working'}
        if len(argv) > 1 and argv[1] == 'api':
            return {'data': {'repository': {'issue': {'state': 'OPEN', 'body': '- [ ] Verify work',
                'labels': {'nodes': [{'name': name} for name in (
                    'worker:peon-cloud', 'target:develop', 'status:in-progress')], 'pageInfo': {'hasNextPage': False}}},
                'pullRequests': {'nodes': [], 'pageInfo': {'hasNextPage': False}}}}}
        raise AssertionError('Unexpected command; real worker/CLI execution is forbidden: ' + str(argv))

    monkeypatch.setattr(source, 'command', command)
    monkeypatch.setattr(core, 'command', command)
    monkeypatch.setattr(plugins, '_plugin_manager', owner.manager)
    monkeypatch.setitem(plugins._plugin_managers_by_home, plugins._plugin_home_key(), owner.manager)
    original = producer.ctx.notification
    async def counted(action, **kwargs):
        state.host_calls.append(action)
        return await original(action, **kwargs)
    monkeypatch.setattr(producer.ctx, 'notification', counted)

    async def fake_inference(authority, ref, row):
        state.inference.append(row['admission_id'])
        return 'Fixture: the worker exited 0; the issue remains OPEN and requires review.'
    monkeypatch.setattr('gateway.session_finite.execute_finite_admission', fake_inference)
    connection = AuthorityConnection(owner.authority, object(), {
        'user_id': 'fixture-rpc-user', 'provider': 'fixture-login', 'profile_id': owner.authority.profile_id})
    from gateway.session_local import create_local_session
    # Create with the connection's real namespaced fixture actor, never retrofit an owner identity.
    owner.ref = create_local_session(owner.authority, connection.actor, {
        'request_id': 'observer-original', 'source': 'gui', 'model': 'fixture', 'toolsets': []})
    owner.actor = connection.actor
    owner.live = owner.authority.sessions[owner.ref.session_id]
    owner.live.event_stream.observers.add(lambda frame: state.frames.append(deepcopy(frame)))

    async def tool(args, *, ref=None):
        from gateway.session_context import set_session_vars, clear_session_vars
        from tools.registry import registry
        target = ref or owner.ref
        tokens = set_session_vars(session_key=owner.authority.sessions[target.session_id].route,
                                  session_id=owner.authority.physical_target(target))
        try:
            raw = await asyncio.to_thread(registry.dispatch, 'stellar_herdr', args, scope=owner.manager.scope_key)
            return json.loads(raw)
        finally:
            clear_session_vars(tokens)

    async def rpc(name, params=None, *, client=None, session=None):
        return await (client or connection).dispatch({'id': 1,
            'method': 'plugin.stellar-herdr.observations.' + name,
            'params': {'session_id': session or owner.ref.session_id, **(params or {})}})

    async def enable():
        result = await tool({'action': 'tracking', 'issue': 23, 'enabled': True,
            'role': 'peon-cloud', 'session_id': receipt['claim_session'], 'kinds': ['worker_exited']})
        assert result.get('delivery') == 'bound_notification_admission', result
        return result

    async def observe_exit():
        state.finished = True
        clock.now += 61
        result = await rpc('reconcile')
        assert 'result' in result, result
        return result

    def event_id():
        with producer.store()[0].transaction() as db:
            row = db.execute('SELECT event_id FROM notification_attempts').fetchone()
            assert row is not None
            return row['event_id']

    return SimpleNamespace(owner=owner, producer=producer, package=package, clock=clock, state=state,
        rpc=rpc, tool=tool, enable=enable, observe_exit=observe_exit, event_id=event_id,
        connection=connection, original_notification=counted)


@pytest.mark.asyncio
async def test_observed_exit_canonical_frames_receipt_dedupe_optout(composed):
    c = composed
    enabled = await c.enable()
    await c.observe_exit()
    event_id = c.event_id()
    assert c.state.host_calls.count('admit') == 1
    await c.owner.authority._drain(c.owner.ref)
    inspected = await c.rpc('inspect', {'event_id': event_id})
    assert inspected['result']['delivery_allowed'] is True, inspected
    host = inspected['result']['host']
    assert host['receipt']['status'] == 'terminal' and host['receipt']['outcome'] == 'completed'
    raw_receipt = await c.connection.dispatch({'id': 2, 'method': 'prompt.receipt', 'params': {
        'session_id': c.owner.ref.session_id, 'admission_id': host['receipt']['admission_id']}})
    start = next(frame for frame in c.state.frames if frame['params']['type'] == 'message.start')
    terminal = next(frame for frame in c.state.frames if frame['params']['type'] == 'message.complete')
    assert start['params']['payload']['display_kind'] == 'internal_notification'
    assert start['params']['payload']['plugin_notification'] == host['descriptor']
    assert terminal['params']['admission_id'] == host['receipt']['admission_id']
    assert terminal['params']['payload']['outcome'] == 'completed'
    c.clock.now += 61
    await c.rpc('reconcile')
    assert c.state.host_calls.count('admit') == 1
    revoked = await c.rpc('revoke', {'event_id': event_id})
    assert revoked['result']['state'] == 'revoked', revoked
    assert (await c.rpc('inspect', {'event_id': event_id}))['result']['delivery_allowed'] is False
    revocation = next(frame for frame in c.state.frames
                      if frame['params']['type'] == 'plugin.stellar-herdr.notification.revoked')

    consumer = Path(CONFIG['consumer_source']) / 'apps/stellar-desktop/src-tauri/src/ivy/ivy_bridge.py'
    spec = importlib.util.spec_from_file_location('immutable_b619_bridge', consumer)
    bridge = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bridge)
    assert bridge.autonomous_start(start['params']['payload']) is False
    proof = {'fixture': True, 'inference': 'fake; no provider call', 'composition': CONFIG,
        'binding': enabled['binding'], 'event_id': event_id, 'raw_start': start,
        'raw_terminal': terminal, 'raw_revoke': revocation, 'raw_events': c.state.frames,
        'canonical_receipt_rpc': raw_receipt, 'producer_inspection_rpc': inspected,
        'consumer_b619_accepts_internal_notification': False}
    (COMPOSITION / 'captured-host-frames.json').write_text(json.dumps(proof, indent=2) + '\n', encoding='utf-8')


@pytest.mark.asyncio
async def test_observed_event_lost_ack_reconciles_after_runtime_restart_without_resend(composed, monkeypatch):
    c = composed
    await c.enable()
    async def lost(action, **params):
        result = await c.original_notification(action, **params)
        if action == 'admit':
            raise OSError('fixture lost ACK AFTER native commit')
        return result
    monkeypatch.setattr(c.producer.ctx, 'notification', lost)
    await c.observe_exit()
    event_id = c.event_id()
    assert c.producer.store()[0].lookup(event_id)['phase'] == 'unknown'
    c.owner.db.close()
    await c.owner.reopen()
    from gateway.session_controls import AuthorityConnection
    c.connection = AuthorityConnection(c.owner.authority, object(), {
        'user_id': 'fixture-rpc-user', 'provider': 'fixture-login', 'profile_id': c.owner.authority.profile_id})
    from gateway.session_local import create_local_session
    c.owner.ref = create_local_session(c.owner.authority, c.connection.actor, {
        'request_id': 'observer-original', 'source': 'gui', 'model': 'fixture', 'toolsets': []})
    c.owner.actor = c.connection.actor
    c.owner.live = c.owner.authority.sessions[c.owner.ref.session_id]
    # rpc closure's old connection belongs to old authority; use the authenticated new one explicitly.
    c.clock.now += 61
    result = await c.rpc('reconcile', client=c.connection)
    assert 'result' in result, result
    assert c.state.host_calls.count('admit') == 1
    saved = c.producer.store()[0].lookup(event_id)
    assert saved['phase'] == 'known'
    receipt = json.loads(saved['outcome'])['receipt']
    assert receipt['status'] == 'queued'
    assert (await c.rpc('inspect', {'event_id': event_id}, client=c.connection))['result']['host']['receipt'] == receipt


@pytest.mark.asyncio
async def test_authenticated_wrong_session_and_readonly_client_cannot_inspect_or_revoke(composed):
    from gateway.session_controls import AuthorityConnection
    from gateway.session_local import create_local_session
    c = composed
    await c.enable()
    await c.observe_exit()
    event_id = c.event_id()
    other = create_local_session(c.owner.authority, c.owner.actor, {'request_id': 'other', 'source': 'gui',
        'model': 'fixture', 'toolsets': []})
    before_calls = len(c.state.host_calls)
    before = c.producer.store()[0].lookup(event_id)
    for method in ('inspect', 'revoke'):
        reply = await c.rpc(method, {'event_id': event_id}, session=other.session_id)
        assert 'error' in reply
    assert c.producer.store()[0].lookup(event_id) == before
    assert len(c.state.host_calls) == before_calls
    reader = AuthorityConnection(c.owner.authority, object(), {
        'user_id': 'fixture-rpc-user', 'provider': 'fixture-login', 'capabilities': ['session:read']})
    assert 'error' in await c.rpc('inspect', {'event_id': event_id}, client=reader)
    assert len(c.state.host_calls) == before_calls


@pytest.mark.asyncio
async def test_optout_during_unknown_host_inspection_suppresses_first_submission(composed, monkeypatch):
    c = composed
    await c.enable()
    entered, release = threading.Event(), threading.Event()
    async def held(action, **params):
        response = await c.original_notification(action, **params)
        if action == 'inspect' and response['status'] == 'unknown':
            entered.set()
            await asyncio.to_thread(release.wait)
        return response
    monkeypatch.setattr(c.producer.ctx, 'notification', held)
    observation = asyncio.create_task(c.observe_exit())
    try:
        if not await asyncio.to_thread(entered.wait, 10):
            release.set()
            await observation
            pytest.fail('The host inspection was not reached')
        event_id = c.event_id()
        revoked = await c.rpc('revoke', {'event_id': event_id})
        assert revoked['result']['state'] == 'revoked'
    finally:
        release.set()
    await observation
    assert c.state.host_calls.count('admit') == 0
    assert c.producer.store()[0].lookup(event_id)['phase'] == 'unknown'


@pytest.mark.asyncio
async def test_concurrent_observer_ticks_admit_one_exact_transition(composed):
    c = composed
    await c.enable()
    c.state.finished = True
    c.clock.now += 61
    results = await asyncio.gather(c.rpc('reconcile'), c.rpc('reconcile'))
    assert all('result' in result for result in results), results
    assert c.state.host_calls.count('admit') == 1
    from hermes_state_runtime import list_session_admissions
    rows = list_session_admissions(c.owner.db, session_id=c.owner.ref.session_id)
    assert len(rows) == 1


@pytest.mark.asyncio
async def test_local_optout_and_freshness_override_host_eligibility(composed, monkeypatch):
    c = composed
    await c.enable()
    await c.observe_exit()
    event_id = c.event_id()
    await c.owner.authority._drain(c.owner.ref)
    c.clock.now += 301
    stale = await c.rpc('inspect', {'event_id': event_id})
    assert stale['result']['host']['delivery_allowed'] is True
    assert stale['result']['delivery_allowed'] is False
    original = c.original_notification
    async def unavailable_revoke(action, **params):
        if action == 'revoke':
            raise OSError('fixture revoke outage')
        return await original(action, **params)
    monkeypatch.setattr(c.producer.ctx, 'notification', unavailable_revoke)
    revoked = await c.rpc('revoke', {'event_id': event_id})
    assert revoked['result']['state'] == 'revoke_pending'
    inspected = await c.rpc('inspect', {'event_id': event_id})
    assert inspected['result']['host']['delivery_allowed'] is True
    assert inspected['result']['delivery_allowed'] is False


def tracking_request():
    return {'action': 'tracking', 'issue': 23, 'enabled': True, 'role': 'peon-cloud',
            'session_id': 'fixture-job-23', 'kinds': ['worker_exited']}


def other_session(c, request_id):
    from gateway.session_local import create_local_session
    return create_local_session(c.owner.authority, c.connection.actor, {
        'request_id': request_id, 'source': 'gui', 'model': 'fixture', 'toolsets': []})


@pytest.mark.asyncio
async def test_tracking_call_never_binds_concurrent_new_revision_to_earlier_session(composed, monkeypatch):
    c = composed
    initial = await c.enable()
    other = other_session(c, 'tracking-race-other')
    revoke_entered, release_revoke = threading.Event(), threading.Event()
    bind_entered, release_bind = threading.Event(), threading.Event()
    async def held(action, **params):
        if action == 'revoke' and params['binding']['revision'] == initial['revision']:
            revoke_entered.set()
            await asyncio.to_thread(release_revoke.wait)
        response = await c.original_notification(action, **params)
        if (action == 'bind' and params['revision'] == initial['revision'] + 2
                and response['owner_session_id'] == other.session_id):
            bind_entered.set()
            await asyncio.to_thread(release_bind.wait)
        return response
    monkeypatch.setattr(c.producer.ctx, 'notification', held)
    first = asyncio.create_task(c.tool(tracking_request()))
    second = None
    try:
        assert await asyncio.to_thread(revoke_entered.wait, 10)
        second = asyncio.create_task(c.tool(tracking_request(), ref=other))
        assert await asyncio.to_thread(bind_entered.wait, 10)
        release_revoke.set()
        earlier = await first
        release_bind.set()
        later = await second
    finally:
        release_revoke.set()
        release_bind.set()
        await asyncio.gather(*(task for task in (first, second) if task is not None), return_exceptions=True)
    assert earlier['delivery'] == 'tracking_changed_before_binding', earlier
    assert earlier['tracking'] is False
    assert later['delivery'] == 'bound_notification_admission', later
    assert later['binding']['owner_session_id'] == other.session_id
    assert c.state.host_calls.count('bind') == 2


@pytest.mark.asyncio
async def test_session_scope_keeps_revision_when_tracking_is_superseded_before_reservation(composed, monkeypatch):
    c = composed
    await c.enable()
    other = other_session(c, 'scope-race-other')
    entered, release = threading.Event(), threading.Event()
    store_type = type(c.producer.store()[0])
    original_scope = store_type.active_scope
    def held(store, session_id):
        result = original_scope(store, session_id)
        entered.set()
        release.wait(10)
        return result
    monkeypatch.setattr(store_type, 'active_scope', held)
    c.clock.now += 61
    pending = asyncio.create_task(c.rpc('reconcile'))
    try:
        assert await asyncio.to_thread(entered.wait, 10)
        newer = await c.tool(tracking_request(), ref=other)
        assert newer['delivery'] == 'bound_notification_admission', newer
        before = c.producer.store()[0].current(23)
        c.clock.now = max(c.clock.now, before['next_poll'] + 1)
        command_count = len(c.state.commands)
    finally:
        release.set()
    result = await pending
    assert result['result']['reconciled'] == 0, result
    assert c.producer.store()[0].current(23) == before
    assert len(c.state.commands) == command_count


@pytest.mark.asyncio
async def test_late_bind_ack_after_optout_reports_invalidated_not_bound(composed, monkeypatch):
    c = composed
    entered, release = threading.Event(), threading.Event()
    async def held(action, **params):
        result = await c.original_notification(action, **params)
        if action == 'bind':
            entered.set()
            await asyncio.to_thread(release.wait)
        return result
    monkeypatch.setattr(c.producer.ctx, 'notification', held)
    pending = asyncio.create_task(c.tool(tracking_request()))
    try:
        assert await asyncio.to_thread(entered.wait, 10)
        disabled = await c.tool({'action': 'tracking', 'issue': 23, 'enabled': False})
        assert disabled['tracking'] is False
    finally:
        release.set()
    result = await pending
    assert result['tracking'] is False, result
    assert result['delivery'] == 'tracking_changed_binding_revoked_or_pending', result
    with c.producer.store()[0].transaction() as db:
        assert db.execute('SELECT phase FROM notification_bindings').fetchone()[0] == 'revoked'


@pytest.mark.asyncio
async def test_lost_bind_ack_after_optout_does_not_report_tracking_active(composed, monkeypatch):
    c = composed
    entered, release = threading.Event(), threading.Event()
    async def held_failure(action, **params):
        result = await c.original_notification(action, **params)
        if action == 'bind':
            entered.set()
            await asyncio.to_thread(release.wait)
            raise OSError('fixture bind ACK lost after local opt-out')
        return result
    monkeypatch.setattr(c.producer.ctx, 'notification', held_failure)
    pending = asyncio.create_task(c.tool(tracking_request()))
    try:
        assert await asyncio.to_thread(entered.wait, 10)
        disabled = await c.tool({'action': 'tracking', 'issue': 23, 'enabled': False})
        assert disabled['tracking'] is False
    finally:
        release.set()
    result = await pending
    assert result['tracking'] is False, result
    assert result['delivery'] == 'tracking_changed_binding_unknown'
    assert c.state.host_calls.count('admit') == 0
