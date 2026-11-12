import { describe, expect, it, vi } from 'vitest';
import type { SpeechSnapshot } from '@stellar/desktop-contracts';
import { initialSpeechSnapshot } from './speech-transport';
import { SpeechPlaybackQueue } from './speech-playback-queue';

const settle = async () => {
  for (let i = 0; i < 12; ++i) await Promise.resolve();
};
function fixture(waitForSlot?: () => Promise<void>) {
  let state = initialSpeechSnapshot();
  const speak = vi.fn(
    async (
      _text: string,
      id: string,
      current: () => boolean,
    ): Promise<SpeechSnapshot> => {
      expect(current()).toBe(true);
      state = {
        ...state,
        revision: String(BigInt(state.revision) + 1n),
        operation_id: id,
        state: 'speaking',
      };
      return state;
    },
  );
  const queue = new SpeechPlaybackQueue({
    state: () => state,
    speak,
    waitForSlot,
  });
  const observe = (change: Partial<SpeechSnapshot>) => {
    state = {
      ...state,
      revision: String(BigInt(state.revision) + 1n),
      ...change,
    };
    queue.observe(state);
  };
  return { queue, speak, observe, state: () => state };
}
describe('owned sequential speech playback', () => {
  it('waits for a long spatial briefing before starting the native deadline', async () => {
    vi.useFakeTimers();
    try {
      let release!: () => void;
      const wait = vi.fn(
        () => new Promise<void>((resolve) => (release = resolve)),
      );
      const f = fixture(wait);
      const result = f.queue.play('Final answer', 'answer');
      await vi.advanceTimersByTimeAsync(180000);
      expect(wait).toHaveBeenCalledOnce();
      expect(f.speak).not.toHaveBeenCalled();
      release();
      await settle();
      expect(f.speak).toHaveBeenCalledOnce();
      f.observe({ operation_id: 'answer', state: 'idle' });
      await expect(result).resolves.toMatchObject({ state: 'idle' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not dispatch a response cleared while waiting for a spatial briefing', async () => {
    let release!: () => void;
    const f = fixture(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const cancelled = expect(
      f.queue.play('Stale response', 'stale'),
    ).rejects.toThrow('cancelled');
    f.queue.clear();
    release();
    await cancelled;
    await settle();
    expect(f.speak).not.toHaveBeenCalled();
    expect(f.queue.busy()).toBe(false);
  });

  it('bounds a missing native completion and never advances the queued owner', async () => {
    vi.useFakeTimers();
    try {
      const stop = vi.fn(async () => undefined);
      const state = initialSpeechSnapshot();
      const speak = vi.fn(
        async (
          _text: string,
          operation_id: string,
        ): Promise<SpeechSnapshot> => ({
          ...state,
          operation_id,
          revision: '1',
          state: 'speaking',
        }),
      );
      const queue = new SpeechPlaybackQueue({
        state: () => state,
        speak,
        stop,
      });
      const results = Promise.allSettled([
        queue.play('First', 'one'),
        queue.play('Second', 'two'),
      ]);
      await vi.advanceTimersByTimeAsync(125000);
      expect(
        (await results).every((result) => result.status === 'rejected'),
      ).toBe(true);
      expect(speak).toHaveBeenCalledOnce();
      expect(stop).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
  it('serializes three utterances and ignores another operation idle event', async () => {
    const f = fixture();
    const one = f.queue.play('Morning.', 'one');
    const two = f.queue.play('Your meeting is at ten.', 'two');
    const three = f.queue.play('Here are the headlines.', 'three');
    await settle();
    f.observe({ operation_id: 'unrelated', state: 'idle' });
    expect(f.speak).toHaveBeenCalledOnce();
    f.observe({ operation_id: 'one', state: 'idle' });
    await one;
    await settle();
    expect(f.speak).toHaveBeenCalledTimes(2);
    f.observe({ operation_id: 'two', state: 'idle' });
    await two;
    await settle();
    f.observe({ operation_id: 'three', state: 'idle' });
    await three;
    expect(f.queue.busy()).toBe(false);
  });

  it('checks a queued lease at dispatch and never starts expired speech', async () => {
    const f = fixture();
    const first = f.queue.play('Question.', 'question');
    let current = true;
    const queued = f.queue.play('Late commentary', 'late', () => current);
    const rejected = expect(queued).rejects.toThrow('expired');
    await settle();
    current = false;
    f.observe({ operation_id: 'question', state: 'idle' });
    await first;
    await rejected;
    expect(f.speak).toHaveBeenCalledOnce();
  });

  it.each(['clear', 'epoch'] as const)(
    'fences active and queued callbacks after %s',
    async (operation) => {
      const f = fixture();
      const first = f.queue.play('First', 'one');
      const second = f.queue.play('Second', 'two');
      const caught = Promise.allSettled([first, second]);
      await settle();
      if (operation === 'clear') f.queue.clear();
      else f.observe({ epoch: '1', state: 'idle' });
      const results = await caught;
      expect(results.every((result) => result.status === 'rejected')).toBe(
        true,
      );
      f.observe({ operation_id: 'one', state: 'idle' });
      expect(f.speak).toHaveBeenCalledOnce();
    },
  );

  it('does not enter a native slot held by an unrelated operation', async () => {
    const f = fixture();
    f.observe({ state: 'collecting', operation_id: 'diagnostic' });
    const pending = f.queue.play('After diagnostic', 'speech');
    expect(f.speak).not.toHaveBeenCalled();
    f.observe({ state: 'idle' });
    await settle();
    f.observe({ state: 'idle', operation_id: 'speech' });
    await pending;
    expect(f.speak).toHaveBeenCalledOnce();
  });

  it('requires both matching completion and the dispatch response', async () => {
    const f = fixture();
    let reply!: (snapshot: SpeechSnapshot) => void;
    f.speak.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          reply = resolve;
        }),
    );
    const first = f.queue.play('First', 'one');
    const second = f.queue.play('Second', 'two');
    f.observe({ operation_id: 'one', state: 'idle' });
    expect(f.speak).toHaveBeenCalledOnce();
    reply(f.state());
    await first;
    await settle();
    f.observe({ operation_id: 'two', state: 'idle' });
    await second;
    expect(f.speak).toHaveBeenCalledTimes(2);
  });

  it('bounds queued text and does not hide overflow by silently dropping it', async () => {
    const f = fixture();
    const pending = Array.from({ length: 17 }, (_, index) =>
      f.queue.play('x', String(index)),
    );
    const caught = Promise.allSettled(pending);
    await expect(f.queue.play('overflow', 'overflow')).rejects.toThrow(
      'capacity',
    );
    await expect(f.queue.play('x'.repeat(4001), 'oversized')).rejects.toThrow(
      'capacity',
    );
    f.queue.clear();
    await caught;
  });
});
