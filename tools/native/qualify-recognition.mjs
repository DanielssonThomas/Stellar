/** Explicit offline native IPC replay; no microphone, synthesis, or Ivy submission. */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { chromium } from '@playwright/test';
import { parseLoopbackEndpoint } from './voice-qualification-core.mjs';

const argv = process.argv.slice(2);
if (argv.length !== 9 || argv[0] !== '--run-synthetic')
  throw new Error(
    'Expected --run-synthetic --endpoint URL --target-id ID --fixtures DIRECTORY --output FILE',
  );
const options = Object.fromEntries(
  Array.from({ length: 4 }, (_, i) => [argv[i * 2 + 1], argv[i * 2 + 2]]),
);
const endpoint = parseLoopbackEndpoint(options['--endpoint']);
const targetId = options['--target-id'];
if (!/^[a-fA-F0-9-]{1,128}$/.test(targetId))
  throw new Error('Invalid target ID');

async function audio(name) {
  const bytes = await readFile(resolve(options['--fixtures'], `${name}.wav`));
  if (
    bytes.length > 2_000_000 ||
    bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.toString('ascii', 8, 12) !== 'WAVE'
  )
    throw new Error('Invalid fixture');
  let format, data;
  for (let at = 12; at + 8 <= bytes.length; ) {
    const size = bytes.readUInt32LE(at + 4);
    if (at + 8 + size > bytes.length) throw new Error('Truncated fixture');
    const type = bytes.toString('ascii', at, at + 4);
    if (type === 'fmt ') format = bytes.subarray(at + 8, at + 8 + size);
    if (type === 'data') data = bytes.subarray(at + 8, at + 8 + size);
    at += 8 + size + (size % 2);
  }
  if (
    !format ||
    format.length < 16 ||
    format.readUInt16LE(0) !== 1 ||
    format.readUInt16LE(2) !== 1 ||
    format.readUInt16LE(14) !== 16 ||
    !data ||
    data.length % 2
  )
    throw new Error('Expected mono PCM16');
  const rate = format.readUInt32LE(4);
  if (rate < 8000 || rate > 192000) throw new Error('Invalid sample rate');
  const pcm = Array.from(
    { length: Math.round(((data.length / 2) * 16000) / rate) },
    (_, index) => {
      const offset = (index * rate) / 16000;
      const left = Math.min(data.length / 2 - 1, Math.floor(offset));
      const right = Math.min(data.length / 2 - 1, left + 1);
      return Math.round(
        data.readInt16LE(left * 2) * (1 - (offset % 1)) +
          data.readInt16LE(right * 2) * (offset % 1),
      );
    },
  );
  if (pcm.length > 320000) throw new Error('Oversized utterance');
  return { pcm, sha256: createHash('sha256').update(bytes).digest('hex') };
}

const browser = await chromium.connectOverCDP(endpoint);
let page;
try {
  for (const context of browser.contexts())
    for (const candidate of context.pages()) {
      const session = await context.newCDPSession(candidate);
      const info = await session.send('Target.getTargetInfo');
      await session.detach();
      if (info.targetInfo.targetId === targetId) page = candidate;
    }
  if (
    !page ||
    !/^(http:\/\/tauri\.localhost|tauri:\/\/localhost)(\/|$)/.test(page.url())
  )
    throw new Error('Expected the explicitly selected native WebView');
  const ready = await page.evaluate(
    () =>
      !!window.__TAURI__?.core &&
      !!document.querySelector('stellar-root') &&
      !document.body.textContent.includes('Stop microphone'),
  );
  if (!ready)
    throw new Error('Use an isolated native app with microphone disabled');
  const invoke = (command, request) =>
    page.evaluate(
      async ({ command, request }) =>
        window.__TAURI__.core.invoke(command, { request }),
      { command, request },
    );
  const snapshot = await invoke('speech_snapshot', { version: 1 });
  if (snapshot.state !== 'idle') throw new Error('Speech is already active');
  const epoch = snapshot.epoch;
  const frames = async (start) =>
    page.evaluate((start) => {
      if (start) {
        if (window.__stellarRecognitionFrames)
          throw new Error('Frame observer already installed');
        const probe = { intervals: [], active: true, last: performance.now() };
        window.__stellarRecognitionFrames = probe;
        const tick = (now) => {
          if (!probe.active) return;
          if (probe.intervals.length < 1800)
            probe.intervals.push(now - probe.last);
          probe.last = now;
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        return null;
      }
      const probe = window.__stellarRecognitionFrames;
      probe.active = false;
      delete window.__stellarRecognitionFrames;
      const sorted = probe.intervals.slice(1).sort((a, b) => a - b);
      return {
        count: sorted.length,
        p50Ms: sorted[Math.floor(sorted.length * 0.5)] ?? null,
        p95Ms: sorted[Math.floor(sorted.length * 0.95)] ?? null,
        maxMs: sorted.at(-1) ?? null,
      };
    }, start);
  const evidence = {
    synthetic: true,
    microphoneUsed: false,
    audiblePlayback: false,
    llmRequests: 0,
    scope: 'real Windows WebView IPC, idle emblem; accelerated audio replay',
    rows: [],
  };
  try {
    await frames(true);
    await page.waitForTimeout(2000);
    evidence.baselineFrames = await frames(false);
    await frames(true);
    for (const [name, mode] of [
      ['wake', 'passive'],
      ['wake-request', 'passive'],
      ['clear', 'listening'],
      ['cancel', 'composing'],
      ['reset', 'listening'],
      ['reload', 'listening'],
    ]) {
      const { pcm, sha256 } = await audio(name);
      const input = pcm.concat(Array(16000).fill(0));
      const stream_id = randomUUID();
      const durations = [],
        detections = [];
      for (let offset = 0; offset < input.length; offset += 640) {
        const start = performance.now();
        const reply = await invoke('speech_keywords', {
          version: 1,
          epoch,
          stream_id,
          sequence: offset / 640,
          pcm: input.slice(offset, offset + 640),
          threshold: 0.008,
          mode,
        });
        durations.push(performance.now() - start);
        if (reply.detection) detections.push(reply.detection.command);
      }
      evidence.rows.push({
        kind: 'keyword',
        fixture: name,
        sha256,
        detections,
        firstChunkMs: durations[0],
        warmMaxChunkMs: Math.max(...durations.slice(1)),
      });
    }
    for (const name of ['long', 'im-done', 'long', 'long']) {
      const { pcm, sha256 } = await audio(name);
      const start = performance.now();
      const reply = await invoke('speech_transcribe', {
        version: 1,
        epoch,
        utterance_id: randomUUID(),
        sample_rate_hz: 16000,
        pcm,
      });
      evidence.rows.push({
        kind: 'stt',
        fixture: name,
        sha256,
        durationMs: performance.now() - start,
        nonempty: typeof reply.text === 'string' && !!reply.text.trim(),
      });
    }
    evidence.inferenceFrames = await frames(false);
  } finally {
    await invoke('speech_stop', { version: 1, epoch });
  }
  await writeFile(
    resolve(options['--output']),
    JSON.stringify(evidence, null, 2) + '\n',
    { flag: 'wx' },
  );
  console.log(JSON.stringify(evidence));
} finally {
  await browser.close();
}
