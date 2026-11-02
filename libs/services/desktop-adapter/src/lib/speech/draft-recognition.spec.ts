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
      ['first', 'one', true, true],
      ['second', 'two', true, true],
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
