"""Execute the immutable observer against final host and consumer; no live effects."""
import json

import pytest

from tests.gateway import test_observer_notification_composition as observer

runtime_owner = observer.runtime_owner
composed = observer.composed
test_lost_ack = observer.test_observed_event_lost_ack_reconciles_after_runtime_restart_without_resend
test_auth = observer.test_authenticated_wrong_session_and_readonly_client_cannot_inspect_or_revoke
test_optout_before_admit = observer.test_optout_during_unknown_host_inspection_suppresses_first_submission
test_concurrent = observer.test_concurrent_observer_ticks_admit_one_exact_transition
test_stale = observer.test_local_optout_and_freshness_override_host_eligibility
test_original_revision = observer.test_tracking_call_never_binds_concurrent_new_revision_to_earlier_session
test_scope = observer.test_session_scope_keeps_revision_when_tracking_is_superseded_before_reservation
test_late_ack = observer.test_late_bind_ack_after_optout_reports_invalidated_not_bound
test_lost_bind_ack = observer.test_lost_bind_ack_after_optout_does_not_report_tracking_active


@pytest.mark.asyncio
async def test_current_observer_canonical_receipt_and_raw_consumer_frames(composed):
    c = composed
    enabled = await c.enable()
    await c.observe_exit()
    event_id = c.event_id()
    await c.owner.authority._drain(c.owner.ref)
    inspected = await c.rpc('inspect', {'event_id': event_id})
    assert inspected['result']['delivery_allowed'] is True, inspected
    host = inspected['result']['host']
    assert host['descriptor']['event_id'] == event_id
    assert host['receipt']['status'] == 'terminal'
    assert host['receipt']['outcome'] == 'completed'
    raw_receipt = await c.connection.dispatch({'id': 2, 'method': 'prompt.receipt', 'params': {
        'session_id': c.owner.ref.session_id, 'admission_id': host['receipt']['admission_id']}})
    start = next(frame for frame in c.state.frames if frame['params']['type'] == 'message.start')
    terminal = next(frame for frame in c.state.frames if frame['params']['type'] == 'message.complete')
    assert start['params']['payload']['display_kind'] == 'internal_notification'
    assert start['params']['payload']['plugin_notification'] == host['descriptor']
    assert terminal['params']['admission_id'] == host['receipt']['admission_id']
    c.clock.now += 61
    await c.rpc('reconcile')
    assert c.state.host_calls.count('admit') == 1
    revoked = await c.rpc('revoke', {'event_id': event_id})
    assert revoked['result']['state'] == 'revoked'
    assert (await c.rpc('inspect', {'event_id': event_id}))['result']['delivery_allowed'] is False
    revocation = next(frame for frame in c.state.frames
                     if frame['params']['type'] == 'plugin.stellar-herdr.notification.revoked')
    proof = {'fixture': True, 'inference': 'fake; no provider call', 'composition': observer.CONFIG,
        'binding': enabled['binding'], 'event_id': event_id, 'raw_start': start,
        'raw_terminal': terminal, 'raw_revoke': revocation, 'raw_events': c.state.frames,
        'canonical_receipt_rpc': raw_receipt, 'producer_inspection_rpc': inspected,
        'producer_revocation_rpc': revoked}
    (observer.COMPOSITION / 'captured-host-frames.json').write_text(json.dumps(proof, indent=2) + '\n', encoding='utf-8')
