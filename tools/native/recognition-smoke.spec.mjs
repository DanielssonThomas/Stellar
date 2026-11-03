import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';

const source = await readFile(
  new URL(
    '../../apps/stellar-desktop/src-tauri/src/recognition_smoke.js',
    import.meta.url,
  ),
  'utf8',
);
async function exercise({
  cancel = true,
  stale = true,
  hidden = false,
  microphone = false,
  guard = true,
} = {}) {
  let epoch = '0',
    pending,
    transcriptions = 0,
    report,
    clock = 0;
  const calls = [],
    frames = [];
  const invoke = async (command, { request, report: value }) => {
    calls.push(command);
    if (command === 'recognition_result') {
      report = value;
      return;
    }
    if (command === 'speech_snapshot') return { epoch };
    if (command === 'speech_keywords') {
      if (request.epoch !== epoch) {
        if (stale) throw 'cancelled';
        return { detection: null };
      }
      return { detection: request.sequence === 0 ? { command: 'ivy' } : null };
    }
    if (command === 'speech_transcribe') {
      assert.match(
        request.utterance_id,
        /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/,
      );
      if (++transcriptions === 5 && cancel)
        return new Promise((_, reject) => {
          pending = reject;
        });
      return { text: 'fixed synthetic text' };
    }
    if (command === 'speech_stop') {
      epoch = String(Number(epoch) + 1);
      pending?.('cancelled');
      return { epoch };
    }
    throw new Error('Unexpected command ' + command);
  };
  await runInNewContext(
    source.replace(
      '__FIXED_PCM__',
      JSON.stringify({ wake: [1], long: [1, 2] }),
    ),
    {
      window: {
        __TAURI__: { core: { invoke } },
        __STELLAR_SPEECH_GUARD__: { installed: guard, attempted: microphone },
      },
      crypto: { randomUUID },
      document: {
        hidden,
        body: { textContent: '' },
        querySelector: () => ({}),
      },
      performance: { now: () => clock },
      requestAnimationFrame: (callback) => frames.push(callback),
      setTimeout: (callback, delay) => {
        for (let at = 0; at < Math.max(delay, 200); at += 16) {
          clock += 16;
          for (const frame of frames.splice(0)) frame(clock);
        }
        queueMicrotask(callback);
      },
    },
  );
  return { report, calls };
}

test('restricted native probe validates IDs, observes cancellation and cleans up', async () => {
  const { report, calls } = await exercise();
  assert.equal(report.success, true);
  assert.equal(report.measurements.length, 10);
  assert.equal(calls.at(-2), 'speech_stop');
  assert.deepEqual([...new Set(calls)].sort(), [
    'recognition_result',
    'speech_keywords',
    'speech_snapshot',
    'speech_stop',
    'speech_transcribe',
  ]);
});
test('a completed cancellation, stale-epoch acceptance or hidden renderer cannot qualify', async () => {
  for (const options of [
    { cancel: false },
    { stale: false },
    { hidden: true },
    { microphone: true },
    { guard: false },
  ])
    assert.equal((await exercise(options)).report.success, false);
});

test('pre-start guard rejects capture without calling the physical media implementation', async () => {
  const guardSource = await readFile(
    new URL(
      '../../apps/stellar-desktop/src-tauri/src/recognition_guard.js',
      import.meta.url,
    ),
    'utf8',
  );
  let physicalCalls = 0;
  const mediaDevices = {
    getUserMedia: async () => {
      physicalCalls++;
    },
  };
  const window = {};
  runInNewContext(guardSource, {
    window,
    navigator: { mediaDevices },
    DOMException,
  });
  assert.equal(window.__STELLAR_SPEECH_GUARD__.installed, true);
  await assert.rejects(mediaDevices.getUserMedia({ audio: true }), {
    name: 'NotAllowedError',
  });
  assert.equal(physicalCalls, 0);
  assert.equal(window.__STELLAR_SPEECH_GUARD__.attempted, true);
  assert.throws(() =>
    Object.defineProperty(mediaDevices, 'getUserMedia', {
      value: () => undefined,
    }),
  );
});
