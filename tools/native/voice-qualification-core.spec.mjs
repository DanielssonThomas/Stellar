import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assessVoiceQualification,
  parseLoopbackEndpoint,
  verifyOfflineFixture,
  verifyOfflineControls,
  waitForVoiceObservation,
} from './voice-qualification-core.mjs';

function success() {
  let at = 0;
  const event = (kind, fields = {}) => ({
    at: ++at,
    active: 0,
    kind,
    ...fields,
  });
  const events = [
    event('invoke', { command: 'speech_transcribe' }),
    event('result', {
      command: 'speech_transcribe',
      ok: true,
      recognized: 'prompt',
    }),
    event('fixture-armed', { active: 1, acquisition: 2, label: 'content-1' }),
    event('live-preview', { active: 1, length: 4 }),
    event('fixture-ended', { active: 1, label: 'content-1' }),
    event('draft-commit', {
      active: 1,
      length: 90,
      appendOnly: true,
      noDuplicates: true,
      firstIntent: true,
      fullIntent: false,
    }),
    event('invoke', {
      active: 1,
      command: 'cleanup_refine',
      cleanupStage: 'first',
      cleanupId: 1,
    }),
    event('result', {
      active: 1,
      command: 'cleanup_refine',
      cleanupId: 1,
      ok: true,
      cleaned: true,
    }),
    event('draft-refined', {
      active: 1,
      revision: 1,
      rawLength: 90,
      cleanupId: 1,
      fullIntent: false,
    }),
    event('fixture-armed', { active: 1, acquisition: 2, label: 'content-2' }),
    event('fixture-started', {
      active: 1,
      acquisition: 2,
      label: 'content-2',
      collectInFlight: true,
    }),
    event('fixture-ended', { active: 1, label: 'content-2' }),
    event('draft-commit', {
      active: 1,
      length: 180,
      appendOnly: true,
      noDuplicates: true,
      firstIntent: true,
      fullIntent: true,
    }),
    event('invoke', {
      active: 1,
      command: 'cleanup_refine',
      cleanupStage: 'full',
      cleanupId: 2,
    }),
    event('result', {
      active: 1,
      command: 'cleanup_refine',
      cleanupId: 2,
      ok: true,
      cleaned: true,
    }),
    event('draft-refined', {
      active: 1,
      revision: 2,
      rawLength: 180,
      cleanupId: 2,
      fullIntent: true,
    }),
    event('fixture-armed', { active: 1, acquisition: 2, label: 'finalize' }),
    event('fixture-started', { active: 1, acquisition: 2, label: 'finalize' }),
    event('fixture-ended', { active: 1, label: 'finalize' }),
    event('result', {
      active: 1,
      command: 'speech_collect',
      ok: true,
      recognized: 'send prompt',
    }),
  ];
  events.push(
    event('invoke', {
      command: 'ivy_submit',
      dissolved: true,
      opacityZero: true,
    }),
    event('ivy-state', { turn: 'completed', verifiedModel: 'sol' }),
    event('expected-pane-visible', { paneCount: 1 }),
    event('invoke', { command: 'speech_speak' }),
    event('speech-state', {
      state: 'synthesizing',
      samePlayback: true,
      error: null,
    }),
    event('speech-state', {
      state: 'speaking',
      samePlayback: true,
      error: null,
    }),
    event('speech-state', { state: 'idle', samePlayback: true, error: null }),
    event('result', { command: 'speech_speak', ok: true }),
    event('track-started', { active: 1 }),
    event('track-stopped', { ended: true }),
    event('track-stopped', { ended: true }),
  );
  return {
    installed: true,
    active: 1,
    acquisitions: 3,
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
      t.events.find((e) => e.recognized === 'send prompt').recognized =
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

test('requires the verified send prompt fixture and live checks', () => {
  for (const mutate of [
    (t) => {
      t.events.find((e) => e.recognized === 'send prompt').recognized =
        'and prompt';
    },
    (t) => {
      t.events = t.events.filter((e) => e.kind !== 'live-preview');
    },
    (t) => {
      t.events.find((e) => e.fullIntent).fullIntent = false;
    },
    (t) => {
      t.events.find(
        (e) => e.kind === 'invoke' && e.command === 'cleanup_refine',
      ).active = 0;
    },
  ]) {
    const trace = success();
    mutate(trace);
    assert.equal(assessVoiceQualification(trace).passed, false);
  }
});

test('accepts multiple append-only segments and rejects loss, duplicates or missing overlap', () => {
  const multiple = success();
  const full = multiple.events.find(
    (event) => event.kind === 'draft-commit' && event.fullIntent,
  );
  const index = multiple.events.indexOf(full);
  multiple.events.splice(index, 0, {
    kind: 'draft-commit',
    at: full.at - 0.5,
    active: 1,
    length: 130,
    appendOnly: true,
    noDuplicates: true,
    firstIntent: true,
    fullIntent: false,
  });
  assert.equal(assessVoiceQualification(multiple).passed, true);
  for (const mutate of [
    (t) => {
      t.events.find(
        (e) => e.kind === 'draft-commit' && e.fullIntent,
      ).appendOnly = false;
    },
    (t) => {
      t.events.find(
        (e) => e.kind === 'draft-commit' && e.fullIntent,
      ).noDuplicates = false;
    },
    (t) => {
      t.events.find(
        (e) => e.kind === 'draft-commit' && e.fullIntent,
      ).fullIntent = false;
    },
    (t) => {
      t.events.find(
        (e) => e.kind === 'fixture-started' && e.label === 'content-2',
      ).collectInFlight = false;
    },
  ]) {
    const trace = success();
    mutate(trace);
    assert.equal(assessVoiceQualification(trace).passed, false);
  }
});

test('requires a successful current full-draft refinement before Send', () => {
  assert.equal(assessVoiceQualification(success()).passed, true);
  for (const mutate of [
    (t) => {
      t.events.find(
        (e) => e.kind === 'draft-refined' && e.fullIntent,
      ).cleanupId = null;
    },
    (t) => {
      t.events.find((e) => e.kind === 'draft-refined' && e.fullIntent)
        .rawLength--;
    },
    (t) => {
      t.events.find((e) => e.kind === 'result' && e.cleanupId === 2).ok = false;
    },
    (t) => {
      t.events.find((e) => e.kind === 'draft-refined' && e.fullIntent).at = 1;
    },
    (t) => {
      t.events.find((e) => e.kind === 'draft-refined' && e.fullIntent).at =
        t.events.find((e) => e.recognized === 'send prompt').at + 1;
    },
  ]) {
    const trace = success();
    mutate(trace);
    assert.equal(assessVoiceQualification(trace).passed, false);
  }
});

test('rejects cancelled, failed or epoch-changed playback even after speaking', () => {
  for (const failure of [
    { samePlayback: false, error: null },
    { samePlayback: true, error: 'cancelled' },
    { samePlayback: true, error: 'error' },
  ]) {
    const trace = success();
    const idle = trace.events.find(
      (event) => event.kind === 'speech-state' && event.state === 'idle',
    );
    Object.assign(idle, failure);
    assert.equal(assessVoiceQualification(trace).passed, false);
  }
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
        fixture: 'content-1',
        exit: 0,
        sha256: 'c',
        actual_voice_command: null,
        synthetic_transcript:
          'stellar text pane native voice check voice pipeline complete',
      },
    ],
  };
  assert.equal(verifyOfflineFixture(receipt, 'worker', 'prompt', 'p'), true);
  assert.equal(verifyOfflineFixture(receipt, 'worker', 'finalize', 'e'), true);
  assert.equal(verifyOfflineFixture(receipt, 'worker', 'content-1', 'c'), true);
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
  assert.equal(
    verifyOfflineFixture(receipt, 'worker', 'content-1', 'c'),
    false,
  );
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

test('accepts stale first refinement and cleanup invocation before polled raw commit', () => {
  const trace = success();
  trace.events = trace.events.filter(
    (event) => !(event.kind === 'draft-refined' && event.revision === 1),
  );
  const first = trace.events.find(
    (event) => event.kind === 'draft-commit' && event.firstIntent,
  );
  const invoke = trace.events.find(
    (event) => event.kind === 'invoke' && event.cleanupStage === 'first',
  );
  invoke.at = first.at - 0.5;
  const full = trace.events.find(
    (event) => event.kind === 'draft-commit' && event.fullIntent,
  );
  trace.events.find(
    (event) => event.kind === 'invoke' && event.cleanupStage === 'full',
  ).at = full.at - 0.5;
  assert.equal(assessVoiceQualification(trace).passed, true);
});

test('preserves last polled trace when the target closes', async () => {
  let reads = 0;
  let retained;
  const page = {
    evaluate: async () => {
      if (reads++) throw new Error('closed');
      return { installed: true, events: [{ kind: 'safe' }] };
    },
  };
  await assert.rejects(
    waitForVoiceObservation(
      page,
      () => false,
      1000,
      (value) => {
        retained = value;
      },
    ),
  );
  assert.deepEqual(retained.events, [{ kind: 'safe' }]);
});
