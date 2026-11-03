import { describe, expect, it, vi } from 'vitest';
import type { KeywordReply } from '@stellar/desktop-contracts';
import { FastCommands, type KeywordPort } from './fast-commands';

const chunk = (sequence: number, value = 7) => ({
  sampleRate: 16000 as const,
  sequence,
  samples: new Int16Array(640).fill(value),
});
const flush = async () => {
  for (let i = 0; i < 12; ++i) await Promise.resolve();
};
function deferred() {
  let resolve!: (reply: KeywordReply) => void;
  return {
    promise: new Promise<KeywordReply>((done) => (resolve = done)),
    resolve: (reply: KeywordReply) => resolve(reply),
  };
}

describe('fast command audio ownership', () => {
  it('preserves all post-wake audio including chunks queued while inference was pending', async () => {
    const pending = deferred();
    const port: KeywordPort = vi.fn(() => pending.promise);
    const detected = vi.fn(),
      failed = vi.fn();
    const owner = new FastCommands(port, () => 'stream', detected, failed);
    const first = chunk(10, 1);
    owner.push(first, 0.008, 'passive');
    owner.push(chunk(11, 2), 0.008, 'passive');
    owner.push(chunk(12, 3), 0.008, 'passive');
    first.samples.fill(0);
    pending.resolve({
      sequence: 10,
      detection: { command: 'ivy', end_sample: 320 },
    });
    await flush();
    expect(failed).not.toHaveBeenCalled();
    const tail = detected.mock.calls[0][1];
    expect(
      tail.map((entry: ReturnType<typeof chunk>) => entry.samples.length),
    ).toEqual([320, 640, 640]);
    expect(
      tail.map((entry: ReturnType<typeof chunk>) => entry.samples[0]),
    ).toEqual([1, 2, 3]);
    expect(port).toHaveBeenCalledOnce();
  });

  it('fences a detection across reset, erases queued PCM and resumes with a new stream', async () => {
    const pending = deferred();
    const port = vi
      .fn<KeywordPort>()
      .mockImplementationOnce(() => pending.promise)
      .mockImplementation(async (_pcm, _id, sequence) => ({
        sequence,
        detection: null,
      }));
    const detected = vi.fn(),
      failed = vi.fn();
    let identity = 0;
    const owner = new FastCommands(
      port,
      () => `stream-${++identity}`,
      detected,
      failed,
    );
    owner.push(chunk(0), 0.008, 'passive');
    owner.push(chunk(1), 0.008, 'passive');
    owner.reset();
    owner.push(chunk(2), 0.008, 'passive');
    pending.resolve({
      sequence: 0,
      detection: { command: 'ivy', end_sample: 320 },
    });
    await flush();
    expect(detected).not.toHaveBeenCalled();
    expect(port.mock.calls.map((call) => call[2])).toEqual([0, 2]);
    expect(port.mock.calls[0][1]).not.toBe(port.mock.calls[1][1]);
    expect(port.mock.calls[0][0].every((value) => value === 0)).toBe(true);
  });

  it('fails closed on discontinuity, backlog, malformed correlation and invalid context', async () => {
    for (const scenario of ['gap', 'backlog', 'correlation', 'context']) {
      const pending = deferred();
      const detected = vi.fn(),
        failed = vi.fn();
      const owner = new FastCommands(
        () => pending.promise,
        () => 'stream',
        detected,
        failed,
      );
      owner.push(chunk(0), 0.008, 'listening');
      if (scenario === 'gap') owner.push(chunk(2), 0.008, 'listening');
      if (scenario === 'backlog')
        for (let i = 1; i <= 65; ++i) owner.push(chunk(i), 0.008, 'listening');
      pending.resolve({
        sequence: scenario === 'correlation' ? 10 : 0,
        detection: {
          command: scenario === 'context' ? 'prompt cancel' : 'clear',
          end_sample: 320,
        },
      });
      await flush();
      expect(failed).toHaveBeenCalledOnce();
      expect(detected).not.toHaveBeenCalled();
    }
  });
  it.each(['prompt', 'reload mcp'] as const)(
    'rejects acoustic %s during composition so queued dictation is retained',
    async (command) => {
      const failed = vi.fn(),
        detected = vi.fn();
      const owner = new FastCommands(
        async (_pcm, _id, sequence) => ({
          sequence,
          detection: { command, end_sample: 640 },
        }),
        () => 'stream',
        detected,
        failed,
      );
      owner.push(chunk(0), 0.008, 'composing');
      await flush();
      expect(failed).toHaveBeenCalledOnce();
      expect(detected).not.toHaveBeenCalled();
    },
  );
  it('rejects a wake endpoint beyond processed audio even when later capture is queued', async () => {
    const pending = deferred(),
      failed = vi.fn(),
      detected = vi.fn();
    const owner = new FastCommands(
      () => pending.promise,
      () => 'stream',
      detected,
      failed,
    );
    owner.push(chunk(0), 0.008, 'passive');
    owner.push(chunk(1), 0.008, 'passive');
    pending.resolve({
      sequence: 0,
      detection: { command: 'ivy', end_sample: 1000 },
    });
    await flush();
    expect(failed).toHaveBeenCalledOnce();
    expect(detected).not.toHaveBeenCalled();
  });
});
