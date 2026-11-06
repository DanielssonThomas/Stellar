import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudVoiceCue } from './cloud-voice-cue';
import { initialSpeechSnapshot } from './speech-transport';

afterEach(() => vi.useRealTimers());
function fixture() {
  vi.useFakeTimers();
  const state = initialSpeechSnapshot();
  let enabled = true;
  const speak = vi.fn(
    async (_text: string, operation_id: string, current?: () => boolean) => {
      void current;
      return {
        ...state,
        operation_id,
        revision: '1',
        state: 'synthesizing' as const,
      };
    },
  );
  const stop = vi.fn(async (): Promise<void> => undefined);
  const stage = vi.fn();
  const cue = new CloudVoiceCue({
    enabled: () => enabled,
    state: () => state,
    speak,
    stop,
    stage,
  });
  return {
    cue,
    state,
    speak,
    stop,
    stage,
    disable: () => {
      enabled = false;
    },
  };
}
describe('cloud voice acknowledgment', () => {
  it('hands off natural completion without restarting the warm voice and ignores unrelated idle', async () => {
    const f = fixture();
    f.cue.schedule('turn');
    await vi.advanceTimersByTimeAsync(700);
    let finished = false;
    const ready = f.cue.handoff().then((result) => {
      finished = result;
    });
    f.cue.observe({ ...f.state, revision: '2', operation_id: 'another' });
    await Promise.resolve();
    expect(finished).toBe(false);
    f.cue.observe({
      ...f.state,
      revision: '3',
      operation_id: f.speak.mock.calls[0][1],
    });
    await ready;
    expect(finished).toBe(true);
    expect(f.stop).not.toHaveBeenCalled();
  });
  it('revokes an undispatched queued cue without waiting for another owner', async () => {
    const f = fixture();
    f.speak.mockImplementationOnce(() => new Promise(() => undefined));
    f.cue.schedule('turn');
    await vi.advanceTimersByTimeAsync(700);
    expect(await f.cue.handoff()).toBe(true);
    expect(f.speak.mock.calls[0][2]?.()).toBe(false);
    expect(f.stop).not.toHaveBeenCalled();
  });
  it('bounds a missing cue completion and waits for the native cancellation result', async () => {
    const f = fixture();
    f.cue.schedule('turn');
    await vi.advanceTimersByTimeAsync(700);
    const ready = f.cue.handoff();
    await vi.advanceTimersByTimeAsync(5000);
    expect(await ready).toBe(true);
    expect(f.stop).toHaveBeenCalledOnce();
  });
  it('keeps ownership through unrelated idle snapshots and revokes queued dispatch on cancel', async () => {
    const f = fixture();
    f.cue.schedule('turn');
    await vi.advanceTimersByTimeAsync(700);
    const current = f.speak.mock.calls[0][2];
    expect(current?.()).toBe(true);
    f.cue.observe({ ...f.state, revision: '2', operation_id: 'question-cue' });
    expect(current?.()).toBe(true);
    await f.cue.cancel();
    expect(f.stop).toHaveBeenCalledOnce();
    expect(current?.()).toBe(false);
  });
  it('waits briefly, acknowledges once and records speech separately from the answer', async () => {
    const f = fixture();
    f.cue.schedule('turn');
    f.cue.schedule('turn');
    await vi.advanceTimersByTimeAsync(699);
    expect(f.speak).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.speak).toHaveBeenCalledExactlyOnceWith(
      'Mm, let me check.',
      expect.any(String),
      expect.any(Function),
    );
    f.cue.observe({
      ...f.state,
      revision: '2',
      operation_id: f.speak.mock.calls[0][1],
      state: 'speaking',
    });
    expect(f.stage.mock.calls.map(([stage]) => stage)).toEqual([
      'acknowledgment_requested',
      'acknowledgment_playback_observed',
    ]);
    f.cue.observe({
      ...f.state,
      revision: '3',
      operation_id: f.speak.mock.calls[0][1],
    });
    await f.cue.cancel();
    expect(f.stop).not.toHaveBeenCalled();
    f.cue.schedule('turn');
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.speak).toHaveBeenCalledOnce();
  });
  it('skips fast answers, mute and other active speech', async () => {
    const fast = fixture();
    fast.cue.schedule('turn');
    expect(await fast.cue.cancel()).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fast.speak).not.toHaveBeenCalled();
    expect(fast.stop).not.toHaveBeenCalled();
    const muted = fixture();
    muted.cue.schedule('turn');
    muted.disable();
    await vi.advanceTimersByTimeAsync(1000);
    expect(muted.speak).not.toHaveBeenCalled();
    const busy = fixture();
    busy.state.state = 'speaking';
    busy.cue.schedule('turn');
    await vi.advanceTimersByTimeAsync(1000);
    expect(busy.speak).not.toHaveBeenCalled();
  });
  it('waits for owned native stop before releasing final narration and reports failure', async () => {
    const f = fixture();
    f.cue.schedule('turn');
    await vi.advanceTimersByTimeAsync(700);
    let finish: () => void = () => undefined;
    f.stop.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    let released = false;
    const cancelled = f.cue.cancel().then((result) => {
      released = result;
    });
    await Promise.resolve();
    expect(released).toBe(false);
    finish();
    await cancelled;
    expect(released).toBe(true);
    f.cue.schedule('another');
    await vi.advanceTimersByTimeAsync(700);
    f.stop.mockRejectedValueOnce(new Error('unavailable'));
    expect(await f.cue.cancel()).toBe(false);
  });
  it('fences late completions after reset and leaves the existing invalidation to stop speech', async () => {
    const f = fixture();
    let failOld: (reason: Error) => void = () => undefined;
    f.speak.mockImplementationOnce(
      () =>
        new Promise<Awaited<ReturnType<typeof f.speak>>>((_, reject) => {
          failOld = reject;
        }),
    );
    f.cue.schedule('old');
    await vi.advanceTimersByTimeAsync(700);
    f.cue.clear();
    f.cue.schedule('new');
    await vi.advanceTimersByTimeAsync(700);
    failOld(new Error('old'));
    await Promise.resolve();
    await f.cue.cancel();
    expect(f.stop).toHaveBeenCalledOnce();
  });
});
