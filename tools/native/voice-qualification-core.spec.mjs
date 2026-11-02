import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assessVoiceQualification,
  parseLoopbackEndpoint,
  verifyOfflineFixture,
  verifyOfflineControls,
} from './voice-qualification-core.mjs';

function success() {
  let at = 0;
  const event = (kind, fields = {}) => ({
    at: ++at,
    active: 0,
    kind,
    ...fields,
  });
  const events = [];
  for (const recognized of ['prompt', 'content', 'end prompt']) {
    events.push(event('invoke', { command: 'speech_transcribe' }));
    events.push(
      event('result', {
        command: 'speech_transcribe',
        ok: true,
        recognized,
        intent: recognized === 'content',
      }),
    );
  }
  events.push(
    event('invoke', { command: 'cleanup_refine' }),
    event('result', { command: 'cleanup_refine', ok: true, cleaned: true }),
    event('invoke', {
      command: 'ivy_submit',
      dissolved: true,
      opacityZero: true,
    }),
    event('ivy-state', { turn: 'completed', verifiedModel: 'sol' }),
    event('expected-pane-visible', { paneCount: 1 }),
    event('invoke', { command: 'speech_speak' }),
    event('speech-state', { state: 'synthesizing' }),
    event('speech-state', { state: 'speaking' }),
    event('speech-state', { state: 'idle' }),
    event('result', { command: 'speech_speak', ok: true }),
    event('track-started', { active: 1 }),
    event('track-stopped', { ended: true }),
    event('track-stopped', { ended: true }),
    event('track-stopped', { ended: true }),
  );
  return {
    installed: true,
    active: 1,
    acquisitions: 4,
    overflow: false,
    events,
  };
}

test('requires real ordered recognition, cleanup, dissolved handoff, verified Sol and playback', () => {
  assert.deepEqual(assessVoiceQualification(success()), {
    passed: true,
    failures: [],
  });
  for (const mutate of [
    (t) => {
      t.events.find((e) => e.recognized === 'end prompt').recognized =
        'content';
    },
    (t) => {
      t.events.find(
        (e) => e.command === 'cleanup_refine' && e.kind === 'result',
      ).cleaned = false;
    },
    (t) => {
      t.events.find((e) => e.command === 'ivy_submit').dissolved = false;
    },
    (t) => {
      const submit = t.events.find((e) => e.command === 'ivy_submit');
      submit.dissolved = false;
      t.events.push({
        kind: 'presentation-dissolved',
        at: submit.at - 1,
        active: 0,
      });
    },
    (t) => {
      t.events.find((e) => e.command === 'ivy_submit').opacityZero = false;
    },
    (t) => {
      t.events = t.events.filter((e) => e.kind !== 'expected-pane-visible');
    },
    (t) => {
      t.events.find((e) => e.command === 'ivy_submit').active = 1;
    },
    (t) => {
      t.events.find((e) => e.kind === 'ivy-state').verifiedModel = 'terra';
    },
    (t) => {
      t.events = t.events.filter((e) => e.state !== 'speaking');
    },
    (t) => {
      t.events.push({ ...t.events.find((e) => e.command === 'ivy_submit') });
    },
    (t) => {
      t.events.find(
        (e) => e.command === 'cleanup_refine' && e.kind === 'result',
      ).at = 1;
    },
    (t) => {
      t.acquisitions = 5;
    },
    (t) => {
      t.active = 0;
    },
  ]) {
    const trace = success();
    mutate(trace);
    assert.equal(assessVoiceQualification(trace).passed, false);
  }
});

test('accepts only supported actual finalization commands', () => {
  for (const command of ['end prompt', 'send prompt', 'send']) {
    const trace = success();
    trace.events.find((event) => event.recognized === 'end prompt').recognized =
      command;
    assert.equal(assessVoiceQualification(trace).passed, true);
  }
  const trace = success();
  trace.events.find((event) => event.recognized === 'end prompt').recognized =
    'and prompt';
  assert.equal(assessVoiceQualification(trace).passed, false);
});

test('refuses remote endpoints, credentials and URL paths', () => {
  assert.equal(
    parseLoopbackEndpoint('http://127.0.0.1:10005'),
    'http://127.0.0.1:10005',
  );
  for (const url of [
    'http://localhost:10005',
    'http://127.0.0.2:10005',
    'http://a@127.0.0.1:10005',
    'https://127.0.0.1:10005',
    'http://127.0.0.1:10005/x',
    'http://127.0.0.1:10005/?q=x',
  ])
    assert.throws(() => parseLoopbackEndpoint(url));
});

test('requires a matching worker, source fixture and independent recognized command', () => {
  const receipt = {
    synthetic: true,
    worker_sha256: 'worker',
    records: [
      {
        fixture: 'prompt',
        exit: 0,
        sha256: 'p',
        actual_voice_command: 'prompt',
      },
      {
        fixture: 'finalize',
        exit: 0,
        sha256: 'e',
        actual_voice_command: 'end prompt',
      },
      {
        fixture: 'owned-content',
        exit: 0,
        sha256: 'c',
        actual_voice_command: null,
        synthetic_transcript:
          'native voice check voice pipeline complete only workspace tools do not read or change any files or settings',
      },
    ],
  };
  assert.equal(verifyOfflineFixture(receipt, 'worker', 'prompt', 'p'), true);
  assert.equal(verifyOfflineFixture(receipt, 'worker', 'finalize', 'e'), true);
  assert.equal(verifyOfflineFixture(receipt, 'worker', 'content', 'c'), true);
  assert.equal(verifyOfflineFixture(receipt, 'other', 'prompt', 'p'), false);
  assert.equal(
    verifyOfflineFixture(receipt, 'worker', 'prompt', 'other'),
    false,
  );
  assert.equal(verifyOfflineFixture(receipt, 'worker', 'unknown', 'p'), false);
  for (const command of ['send', 'send prompt']) {
    receipt.records[1].actual_voice_command = command;
    assert.equal(
      verifyOfflineFixture(receipt, 'worker', 'finalize', 'e'),
      true,
    );
  }
  receipt.records[1].actual_voice_command = 'and prompt';
  assert.equal(verifyOfflineFixture(receipt, 'worker', 'finalize', 'e'), false);
  receipt.records[1].actual_voice_command = null;
  assert.equal(verifyOfflineFixture(receipt, 'worker', 'finalize', 'e'), false);
  receipt.records[2].synthetic_transcript = 'only workspace tools';
  assert.equal(verifyOfflineFixture(receipt, 'worker', 'content', 'c'), false);
});

test('requires near-command negative, ordinary and silence controls', () => {
  const receipt = {
    records: [
      {
        fixture: 'negative-and-prompt',
        exit: 0,
        sha256: 'negative',
        actual_voice_command: null,
      },
      { fixture: 'cached-content', exit: 0, actual_voice_command: null },
      {
        fixture: 'silence',
        exit: 0,
        actual_voice_command: null,
        synthetic_transcript: '',
      },
    ],
  };
  assert.equal(verifyOfflineControls(receipt, 'negative'), true);
  assert.equal(verifyOfflineControls(receipt, 'different'), false);
  receipt.records[0].actual_voice_command = 'end prompt';
  assert.equal(verifyOfflineControls(receipt, 'negative'), false);
  receipt.records[0].actual_voice_command = null;
  receipt.records[2].synthetic_transcript = 'invented';
  assert.equal(verifyOfflineControls(receipt, 'negative'), false);
});
