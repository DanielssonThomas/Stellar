"""Real candidate authority restart on fixture-only state, no model/socket/worker."""

import json

import pytest

from tests.gateway import test_observer_notification_composition as observer

runtime_owner = observer.runtime_owner
composed = observer.composed


@pytest.mark.asyncio
@pytest.mark.parametrize("missed", [False, True])
async def test_retained_notice_canonical_receipt_survives_but_replay_epoch_changes(
    composed, missed,
):
    from gateway.config import GatewayConfig
    from gateway.run import GatewayRunner
    from gateway.session_authority import initialize_session_authority
    from gateway.session_controls import AuthorityConnection

    c = composed
    enabled = await c.enable()
    await c.observe_exit()
    await c.owner.authority._drain(c.owner.ref)
    event = c.event_id()
    before = await c.rpc("inspect", {"event_id": event})
    start = next(
        frame for frame in c.state.frames if frame["params"]["type"] == "message.start"
    )
    revoked = await c.rpc("revoke", {"event_id": event})
    assert revoked["result"]["state"] == "revoked"
    revocation = next(
        frame
        for frame in c.state.frames
        if frame["params"]["type"] == "plugin.stellar-herdr.notification.revoked"
    )
    if missed:
        c.state.finished = False
        await c.enable()
        await c.observe_exit()
        await c.owner.authority._drain(c.owner.ref)
    old_epoch = start["params"]["replay_epoch"]
    owner = c.owner
    sid, profile = owner.ref.session_id, owner.authority.profile_id
    owner.db.close()
    from hermes_state import SessionDB

    db = SessionDB(owner.home / "state.db")
    runner = GatewayRunner(GatewayConfig(sessions_dir=owner.home / "sessions"))
    runner.session_store._db = db
    runner._session_db, runner._gateway_loop, runner._running = (
        db,
        __import__("asyncio").get_running_loop(),
        True,
    )
    authority = await initialize_session_authority(
        runner, profile_id=profile, instance_id="fixture-recovery", db=db
    )
    owner.runner, owner.authority, owner.db = runner, authority, db
    connection = AuthorityConnection(
        authority,
        object(),
        {
            "user_id": "fixture-rpc-user",
            "provider": "fixture-login",
            "profile_id": profile,
        },
    )
    resumed = await connection.dispatch(
        {"id": 1, "method": "session.resume", "params": {"session_id": sid}}
    )
    assert resumed["result"]["session_id"] == sid, resumed
    inspected = await c.rpc(
        "inspect", {"event_id": event}, client=connection, session=sid
    )
    assert (
        inspected["result"]["host"]["receipt"]["admission_id"]
        == before["result"]["host"]["receipt"]["admission_id"]
    )
    assert inspected["result"]["host"]["receipt"]["status"] == "terminal"
    replay = await connection.dispatch(
        {
            "id": 2,
            "method": "session.events.since",
            "params": {
                "session_id": sid,
                "replay_epoch": old_epoch,
                "last_sequence": start["params"]["seq"],
            },
        }
    )
    assert "result" in replay, replay
    assert replay["result"]["truncated"] is True, replay
    assert replay["result"]["snapshot_required"] is True, replay
    assert replay["result"]["replay_epoch"] != old_epoch, replay
    assert c.state.host_calls.count("admit") == (2 if missed else 1)
    output = {
        "fixtureOnly": True,
        "realInference": False,
        "installedStateUsed": False,
        "binding": enabled["binding"],
        "raw_start": start,
        "producer_inspection_rpc": before,
        "recovered_inspection_rpc": inspected,
        "resume_after_restart": resumed,
        "replay_after_restart": replay,
        "revocation_rpc": revoked,
        "raw_revoke": revocation,
        "old_epoch": old_epoch,
        "admit_count": c.state.host_calls.count("admit"),
    }
    # Exercise the actual consumer boundary against this real authority and read-only store.
    import importlib.util
    import sys
    from types import SimpleNamespace
    folder = __import__('pathlib').Path(observer.CONFIG['consumer_source']) / 'apps/stellar-desktop/src-tauri/src/ivy'
    for name, file in [('stellar_ivy_notifications','ivy_notifications.py'), ('stellar_ivy_controls','ivy_controls.py'), ('stellar_ivy_recovery_store','ivy_recovery_store.py'), ('stellar_ivy_recovery','ivy_recovery.py')]:
        spec = importlib.util.spec_from_file_location(name, folder / file)
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    spec = importlib.util.spec_from_file_location('consumer_recovery_bridge',folder / 'ivy_bridge.py')
    bridge = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bridge)
    bridge.PROFILE = owner.home
    class Client:
        async def rpc(self, method, **params):
            result = await connection.dispatch({'id':9, 'method':method, 'params':params})
            assert 'result' in result, result
            return result['result']
    peer = SimpleNamespace(client=Client(), selected_session=sid)
    from stellar_ivy_recovery import recover
    recovered = await recover(peer, {'session_id':sid,'after_sequence':0,'retained':[before['result']['host']['receipt']['admission_id']]},owner.home,15,
        lambda conn,params:bridge.replay_events(conn,params,None))
    output['recovery_rpc'] = recovered
    inspections = {}
    for entry in recovered['entries']:
        if entry['descriptor']:
            inspected_entry = await c.rpc('inspect',{'event_id':entry['descriptor']['event_id']},client=connection,session=sid)
            inspections[entry['receipt']['admission_id']] = inspected_entry['result']
    output['recovered_inspections'] = inspections
    output['missed'] = missed
    assert len(recovered['entries']) == (2 if missed else 1)
    assert recovered['snapshot']['replay_epoch'] != old_epoch
    assert c.state.host_calls.count('admit') == (2 if missed else 1)
    (observer.COMPOSITION / ('consumer-recovery-missed.json' if missed else 'consumer-recovery-retained.json')).write_text(json.dumps(output,indent=2)+'\n')
    (observer.COMPOSITION / "recovery-host-frames.json").write_text(
        json.dumps(output, indent=2) + "\n"
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("committed", [False, True])
async def test_uncertain_observation_only_inspects_after_store_reopen_never_resends(
    composed, monkeypatch, committed
):
    from hermes_state_runtime import list_session_admissions

    c = composed
    await c.enable()

    async def lost(action, **params):
        if action == "admit":
            if committed:
                await c.original_notification(action, **params)
            raise OSError("FIXTURE ambiguous acknowledgement")
        return await c.original_notification(action, **params)

    monkeypatch.setattr(c.producer.ctx, "notification", lost)
    await c.observe_exit()
    event = c.event_id()
    assert c.producer.store()[0].lookup(event)["phase"] == "unknown"
    before = len(list_session_admissions(c.owner.db, session_id=c.owner.ref.session_id))
    c.clock.now += 61
    await c.rpc("reconcile")
    row = c.producer.store()[0].lookup(event)
    assert row["phase"] == ("known" if committed else "unknown")
    assert (
        len(list_session_admissions(c.owner.db, session_id=c.owner.ref.session_id))
        == before
    )
    assert c.state.host_calls.count("admit") == (1 if committed else 0)
