import { describe, expect, it, vi } from 'vitest';
import { DraftRecognition } from './draft-recognition';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

describe('draft recognition scheduling', () => {
  it('drops reset work waiting for the shared collect slot and resumes with the new generation', async () => {
    const passive = deferred<void>();
    const completed = vi.fn();
    const failed = vi.fn();
    const timing = vi.fn();
    const collect = vi.fn(async (_pcm: Int16Array, utterance_id: string) => ({
      version: 1,
      utterance_id,
      text: 'new request',
    }));
    const queue = new DraftRecognition(
      collect,
      async () => undefined,
      completed,
      failed,
      false,
      timing,
      () => passive.promise,
    );
    const stale = new Int16Array([1]);
    const current = new Int16Array([2]);
    queue.offer(stale, 'stale', true);
    expect(collect).not.toHaveBeenCalled();
    expect(timing).toHaveBeenCalledExactlyOnceWith('queued');
    await queue.reset();
    queue.offer(current, 'current', true);
    passive.resolve();
    await vi.waitFor(() => expect(queue.isBusy()).toBe(false));
    expect(collect).toHaveBeenCalledExactlyOnceWith(current, 'current');
    expect(completed).toHaveBeenCalledExactlyOnceWith(
      'new request',
      'current',
      true,
      true,
      true,
    );
    expect(failed).not.toHaveBeenCalled();
    expect(timing.mock.calls.map(([stage]) => stage)).toEqual([
      'queued',
      'queued',
      'started',
      'completed',
    ]);
    expect([...stale, ...current]).toEqual([0, 0]);
  });

  it('waits for a warm preview before the final without restarting shared recognizers', async () => {
    const partial = deferred<{
      version: number;
      utterance_id: string;
      text: string;
    }>();
    const collect = vi
      .fn()
      .mockReturnValueOnce(partial.promise)
      .mockResolvedValueOnce({
        version: 1,
        utterance_id: 'final',
        text: 'retained complete dictation',
      });
    const stop = vi.fn(async () => undefined),
      completed = vi.fn();
    const queue = new DraftRecognition(
      collect,
      stop,
      completed,
      vi.fn(),
      false,
    );
    const preview = new Int16Array([1]),
      final = new Int16Array([2]);
    queue.offer(preview, 'preview', false);
    queue.offer(final, 'final', true);
    expect(collect).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();
    partial.resolve({ version: 1, utterance_id: 'preview', text: 'partial' });
    await flush();
    expect(completed).toHaveBeenLastCalledWith(
      'retained complete dictation',
      'final',
      true,
      true,
      true,
    );
    expect(collect).toHaveBeenCalledTimes(2);
    expect(stop).not.toHaveBeenCalled();
    expect([...preview, ...final]).toEqual([0, 0]);
  });

  it('keeps initial wake eligibility separate from capped command eligibility', async () => {
    const completed = vi.fn();
    const queue = new DraftRecognition(
      async (_pcm, utterance_id) => ({
        version: 1,
        utterance_id,
        text: 'Ivy, explain the plan',
      }),
      async () => undefined,
      completed,
      vi.fn(),
    );
    queue.offer(new Int16Array([1]), 'initial-cap', true, false, 'draft', true);
    await flush();
    expect(completed).toHaveBeenCalledExactlyOnceWith(
      'Ivy, explain the plan',
      'initial-cap',
      true,
      false,
      true,
    );
  });

  it('finishes an in-flight wake preview before the queued final without preemption', async () => {
    const first = deferred<{
      version: number;
      utterance_id: string;
      text: string;
    }>();
    const collect = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({
        version: 1,
        utterance_id: 'final',
        text: 'a request',
      });
    const completed = vi.fn();
    const stop = vi.fn(async () => undefined);
    const queue = new DraftRecognition(collect, stop, completed, vi.fn());
    const preview = new Int16Array([1]);
    const final = new Int16Array([2]);
    queue.offer(preview, 'wake', false, true, 'wake');
    queue.offer(final, 'final', true);
    expect(stop).not.toHaveBeenCalled();
    first.resolve({ version: 1, utterance_id: 'wake', text: 'Ivy' });
    await flush();
    expect(completed.mock.calls).toEqual([
      ['Ivy', 'wake', false, true, true],
      ['a request', 'final', true, true, true],
    ]);
    expect([...preview, ...final]).toEqual([0, 0]);
  });
  it('does not publish an older partial once a newer partial is queued', async () => {
    const first = deferred<{
      version: number;
      utterance_id: string;
      text: string;
    }>();
    const collect = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({
        version: 1,
        utterance_id: 'new',
        text: 'newer',
      });
    const completed = vi.fn();
    const queue = new DraftRecognition(
      collect,
      async () => undefined,
      completed,
      vi.fn(),
    );
    queue.offer(new Int16Array([1]), 'old', false);
    expect(queue.canPreview()).toBe(false);
    queue.offer(new Int16Array([2]), 'new', false);
    first.resolve({ version: 1, utterance_id: 'old', text: 'older' });
    await flush();
    expect(completed).toHaveBeenCalledExactlyOnceWith(
      'newer',
      'new',
      false,
      true,
      true,
    );
    expect(queue.canPreview()).toBe(true);
  });
  it('serializes complete utterances captured while an earlier one is still processing', async () => {
    const first = deferred<{
      version: number;
      utterance_id: string;
      text: string;
    }>();
    const collect = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({
        version: 1,
        utterance_id: 'two',
        text: 'second',
      });
    const completed = vi.fn();
    const queue = new DraftRecognition(
      collect,
      async () => undefined,
      completed,
      vi.fn(),
    );
    queue.offer(new Int16Array([1]), 'one', true);
    queue.offer(new Int16Array([2]), 'two', true);
    expect(collect).toHaveBeenCalledTimes(1);
    first.resolve({ version: 1, utterance_id: 'one', text: 'first' });
    await flush();
    expect(completed.mock.calls).toEqual([
      ['first', 'one', true, true, true],
      ['second', 'two', true, true, true],
    ]);
    expect(collect).toHaveBeenCalledTimes(2);
  });

  it('ignores a late result after reset', async () => {
    const pending = deferred<{
      version: number;
      utterance_id: string;
      text: string;
    }>();
    const completed = vi.fn();
    const queue = new DraftRecognition(
      () => pending.promise,
      async () => undefined,
      completed,
      vi.fn(),
    );
    const pcm = new Int16Array([3]);
    queue.offer(pcm, 'old', true);
    queue.reset();
    pending.resolve({ version: 1, utterance_id: 'old', text: 'stale' });
    await flush();
    expect(completed).not.toHaveBeenCalled();
    expect(pcm[0]).toBe(0);
  });
  it('preempts a partial for a complete utterance and never emits the stale partial', async () => {
    const partial = deferred<{
      version: number;
      utterance_id: string;
      text: string;
    }>();
    const collect = vi
      .fn()
      .mockReturnValueOnce(partial.promise)
      .mockResolvedValueOnce({
        version: 1,
        utterance_id: 'final',
        text: 'complete',
      });
    const stop = vi.fn(async () => {
      partial.resolve({ version: 1, utterance_id: 'partial', text: 'send' });
    });
    const completed = vi.fn();
    const queue = new DraftRecognition(collect, stop, completed, vi.fn());
    const a = new Int16Array([1]);
    const b = new Int16Array([2]);
    queue.offer(a, 'partial', false);
    queue.offer(b, 'final', true);
    await flush();
    expect(stop).toHaveBeenCalledOnce();
    expect(completed).toHaveBeenCalledExactlyOnceWith(
      'complete',
      'final',
      true,
      true,
      true,
    );
    expect([...a, ...b]).toEqual([0, 0]);
  });

  it('bounds the final queue and erases pending audio instead of silently dropping it', async () => {
    const pending = deferred<never>();
    const failed = vi.fn();
    const queue = new DraftRecognition(
      () => pending.promise,
      async () => undefined,
      vi.fn(),
      failed,
    );
    const buffers = Array.from({ length: 5 }, () => new Int16Array([7]));
    buffers.forEach((pcm, i) => queue.offer(pcm, String(i), true));
    expect(failed).toHaveBeenCalledOnce();
    expect(buffers.slice(1).every((pcm) => pcm[0] === 0)).toBe(true);
  });
});
