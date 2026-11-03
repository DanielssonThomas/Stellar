/** Actual coordinator replay; effects are inert, models are local CPU workers. */
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ActivityDetector } from '../../libs/services/audio-activity/src/lib/activity-detector';
import {
  VoiceConversation,
  type VoiceContext,
} from '../../libs/services/desktop-adapter/src/lib/speech/voice-conversation';
import { voiceCommand } from '../../libs/services/desktop-adapter/src/lib/speech/voice-composition';
import { initialIvySnapshot } from '../../libs/services/desktop-adapter/src/lib/ivy/ivy-transport';
import { initialSpeechSnapshot } from '../../libs/services/desktop-adapter/src/lib/speech/speech-transport';
declare const __REPLAY_SOURCE__: {
  baseline: boolean;
  coordinatorSha256: string;
};

const [flag, folder, output] = process.argv.slice(2);
if (flag !== '--run-offline' || !folder || !output || process.argv.length !== 5)
  throw new Error('Expected --run-offline FIXTURE_DIRECTORY OUTPUT');
const manifest = JSON.parse(
  await readFile(resolve(folder, 'manifest.json'), 'utf8'),
);
const child = spawn(
  'D:/Hermes/profiles/ivy/recognition/.venv/Scripts/python.exe',
  ['-I', 'tools/native/replay-conversation-worker.py', folder],
  { windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] },
);
const lines = createInterface({ input: child.stdout });
let tail = Promise.resolve();
let waiting: ((value: any) => void) | undefined;
let rejectWaiting: ((error: Error) => void) | undefined;
lines.on('line', (line) => {
  if (!waiting) throw new Error('Unexpected benchmark reply');
  const resolve = waiting;
  waiting = undefined;
  resolve(JSON.parse(line));
});
child.on('exit', () => rejectWaiting?.(new Error('Benchmark worker exited')));
function request(value: unknown): Promise<any> {
  const next = tail.then(
    () =>
      new Promise((done, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Benchmark worker deadline')),
          60000,
        );
        waiting = (value) => {
          clearTimeout(timer);
          done(value);
        };
        rejectWaiting = (error) => {
          clearTimeout(timer);
          reject(error);
        };
        child.stdin.write(JSON.stringify(value) + '\n');
      }),
  );
  tail = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}
const rows = [];
try {
  for (let index = 0; index < manifest.trials.length; index++) {
    const trial = manifest.trials[index];
    const { pcm } = await request({ kind: 'fixture', index });
    const detector = new ActivityDetector();
    let context: VoiceContext = {
      available: true,
      audio: { status: 'capturing', activity: detector.snapshot() },
      assistant: { ...initialIvySnapshot(), connection: 'ready' },
      speech: initialSpeechSnapshot(),
    };
    let at = 0,
      sequence = 0,
      wake = false,
      lastPassive = true,
      lastComposition = 'idle',
      armed = false;
    const events: any[] = [],
      fallback: any[] = [];
    let pending: Promise<unknown>[] = [];
    const transcribe = (samples: Int16Array, utterance_id: string) => {
      const settled = at,
        start = performance.now();
      const job = request({
        kind: 'transcribe',
        request: { pcm: Array.from(samples), sample_rate_hz: 16000 },
      }).then((reply) => {
        fallback.push({
          finalizedAtAudioMs: settled,
          computeMs: performance.now() - start,
          command: voiceCommand(reply.text),
          empty: !reply.text.trim(),
        });
        return { version: 1, utterance_id, text: reply.text };
      });
      pending.push(job);
      return job;
    };
    const controller = new VoiceConversation({
      id: randomUUID,
      stop: async () => undefined,
      readSession: async () => 'sol',
      selectSession: async () => true,
      clearConversation: async () => {
        events.push({ kind: 'clear-or-done', atAudioMs: at });
        return true;
      },
      newSession: async () => {
        events.push({ kind: 'new session', atAudioMs: at });
        return true;
      },
      reloadMcp: async () => {
        events.push({ kind: 'reload mcp', atAudioMs: at });
        return true;
      },
      keywords: (samples, stream_id, sequence, threshold, mode) => {
        const job = request({
          kind: 'keywords',
          request: {
            pcm: Array.from(samples),
            stream_id,
            sequence,
            threshold,
            mode,
          },
        }).then((reply) => {
          if (reply.detection)
            events.push({
              kind: 'keyword-candidate',
              command: reply.detection.command,
              atAudioMs: at,
              sequence,
            });
          return reply;
        });
        pending.push(job);
        return job;
      },
      transcribe,
      collect: transcribe,
      submit: async () => {
        events.push({ kind: 'conversation-submission', atAudioMs: at });
        return true;
      },
      speak: async () => initialSpeechSnapshot(),
      onChange: (view) => {
        if (armed && lastPassive && !view.passive) {
          wake = true;
          events.push({ kind: 'ivy', atAudioMs: at });
        }
        lastPassive = !!view.passive;
      },
      onComposition: (state) => {
        if (armed && lastComposition !== state.status)
          events.push({
            kind:
              state.status === 'composing'
                ? 'prompt'
                : state.status === 'idle'
                  ? 'composition-ended'
                  : state.status,
            atAudioMs: at,
          });
        lastComposition = state.status;
      },
    });
    controller.update(context);
    if (trial.mode === 'composing')
      controller.setDraft('Fixed synthetic draft retained until cancellation.');
    else if (trial.mode === 'listening')
      await controller.withCaptureReleased(async () => true);
    armed = true;
    const data = [...Array(16000).fill(0), ...pcm, ...Array(48000).fill(0)];
    for (let offset = 0; offset < data.length; offset += 640) {
      const samples = Int16Array.from(data.slice(offset, offset + 640));
      at = (offset + samples.length) / 16 - 1000;
      const rms = Math.sqrt(
        samples.reduce((total, sample) => total + (sample / 32768) ** 2, 0) /
          samples.length,
      );
      const activity = detector.push({
        timestampMs: (offset + 640) / 16,
        rms,
        peak: 0,
        clipped: false,
      });
      context = { ...context, audio: { status: 'capturing', activity } };
      controller.update(context);
      controller.accept(
        {
          type: 'chunk',
          chunk: { sampleRate: 16000, sequence: sequence++, samples },
        },
        context.audio,
      );
      // Drain each frame deterministically: excludes native IPC/backpressure timing.
      while (pending.length) {
        const jobs = pending;
        pending = [];
        await Promise.all(jobs);
        for (let i = 0; i < 32; i++) await Promise.resolve();
      }
    }
    rows.push({
      id: trial.id,
      expected: trial.expected,
      mode: trial.mode,
      wake,
      events,
      fallback,
    });
    controller.dispose();
    pcm.fill(0);
    data.fill(0);
  }
  await writeFile(
    output,
    JSON.stringify(
      {
        scope:
          'Actual VoiceConversation + ActivityDetector + assembler, 40ms RMS replay approximation, warm local engines, inert side effects. Not real-time native or physical endpoint latency.',
        source: __REPLAY_SOURCE__,
        fixtureKind: manifest.fixtureKind,
        rows,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      trials: rows.length,
      fallbackTrials: rows.filter((row) => row.fallback.length).length,
    }),
  );
} finally {
  lines.close();
  child.stdin.end();
  if (child.exitCode === null)
    await new Promise<void>((done) => {
      const deadline = setTimeout(() => {
        if (child.exitCode === null && child.pid)
          spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          });
        done();
      }, 3000);
      child.once('close', () => {
        clearTimeout(deadline);
        done();
      });
    });
}
