"""Copied into a disposable candidate test tree; canonical host data, fake inference only."""
import json
from pathlib import Path

import pytest

from tests.gateway.test_plugin_notifications import owner  # noqa: F401


@pytest.mark.asyncio
async def test_capture_consumer_frames(owner):
    from hermes_state_runtime import settle_session_input

    binding = await owner.bind()
    frames = []
    owner.live.event_stream.observers.add(frames.append)
    content = '{"milestone":"fixture_completed","authority":"none"}'
    event_id = 'consumer-canonical-fixture'
    queued = await owner.ctx.notification(
        'admit', binding=binding, event_id=event_id, content=content)
    row, _ = await owner.authority._claim_with_retry(owner.ref, owner.live)
    assert row['admission_id'] == queued['receipt']['admission_id']
    started = await owner.ctx.notification('inspect', binding=binding, event_id=event_id)
    settle_session_input(owner.db, epoch=owner.authority.epoch,
                         admission_id=row['admission_id'], generation=row['generation'],
                         outcome='completed', result={'result': {
                             'final_response': '{"stellar_presentation":{"action":"close_activity"},'
                             '"text":"Canonical candidate answer; no action taken."}'}})
    owner.authority.executing.pop(owner.ref.session_id, None)
    terminal = await owner.ctx.notification('inspect', binding=binding, event_id=event_id)
    unknown = await owner.ctx.notification('inspect', binding=binding, event_id='never-admitted')
    revoked = await owner.ctx.notification('revoke', binding=binding)
    denied = await owner.ctx.notification('inspect', binding=binding, event_id=event_id)
    newer_binding = await owner.bind(revision=2)
    await owner.ctx.notification('admit', binding=newer_binding,
                                 event_id='cancel-before-claim', content=content)
    newer_revoke = await owner.ctx.notification('revoke', binding=newer_binding)
    cancelled = await owner.ctx.notification('inspect', binding=newer_binding,
                                            event_id='cancel-before-claim')
    assert cancelled['receipt']['outcome'] == 'cancelled'
    assert cancelled['receipt']['execution_generation'] is None
    owner.db.delete_session(owner.ref.session_id)
    tombstone = await owner.ctx.notification('inspect', binding=binding, event_id=event_id)
    assert tombstone['descriptor'] is None and not tombstone['delivery_allowed']
    assert queued['receipt']['execution_generation'] is None
    assert not started['delivery_allowed']
    assert terminal['delivery_allowed']
    assert not denied['delivery_allowed']
    output = Path(__file__).resolve().parents[2] / 'consumer-canonical-frames.json'
    output.write_text(json.dumps({
        'fixture_only': True,
        'inference': 'poisoned; canonical result settled explicitly by test',
        'expected_profile': str(owner.home),
        'expected_plugin': 'fixture-notifier',
        'binding': binding, 'event_id': event_id, 'content': content,
        'frames': frames, 'queued': queued, 'started': started,
        'terminal': terminal, 'unknown': unknown, 'revoked': revoked, 'denied': denied,
        'cancelled': cancelled, 'newer_revoke': newer_revoke, 'tombstone': tombstone,
    }, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
