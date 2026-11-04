import { afterEach, describe, expect, it, vi } from 'vitest';
import { VolumeDucking } from './volume-ducking';
import type { SpeechTransport } from './speech-transport';

function fixture() {
  vi.useFakeTimers();
  const invoke = vi.fn<SpeechTransport['invoke']>().mockResolvedValue(null);
  const ducking = new VolumeDucking({
    invoke,
    listen: async () => () => undefined,
  });
  const values = () => invoke.mock.calls.map(([, args]) => args.request);
  return { ducking, invoke, values };
}

afterEach(() => vi.useRealTimers());

describe('native volume lease', () => {
  it('does not deliver a queued activation after disposal', async () => {
    const f = fixture();
    f.ducking.set(true);
    f.ducking.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.values()).toEqual([{ version: 1, active: false }]);
  });
  it('renews without reapplying reductions and releases when the turn ends', async () => {
    const f = fixture();
    f.ducking.set(true);
    f.ducking.set(true);
    await vi.advanceTimersByTimeAsync(4000);
    expect(f.values()).toEqual(Array(3).fill({ version: 1, active: true }));
    f.ducking.set(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.values().at(-1)).toEqual({ version: 1, active: false });
    const count = f.invoke.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.invoke).toHaveBeenCalledTimes(count);
    f.ducking.dispose();
  });

  it('bridges listening pauses into thinking without releasing between stages', async () => {
    const f = fixture();
    f.ducking.set(true, true);
    f.ducking.set(false, true);
    await vi.advanceTimersByTimeAsync(1400);
    f.ducking.set(true);
    await vi.advanceTimersByTimeAsync(300);
    expect(f.values()).toEqual([{ version: 1, active: true }]);
    f.ducking.set(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.values().at(-1)).toEqual({ version: 1, active: false });
    f.ducking.dispose();
  });

  it('ends idle listening and restores immediately on stop/disposal during a pause', async () => {
    const f = fixture();
    f.ducking.set(true, true);
    f.ducking.set(false, true);
    await vi.advanceTimersByTimeAsync(1600);
    expect(f.values().at(-1)).toEqual({ version: 1, active: false });
    f.ducking.set(true, true);
    f.ducking.set(false, true);
    f.ducking.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.values().at(-1)).toEqual({ version: 1, active: false });
    const count = f.invoke.mock.calls.length;
    f.ducking.set(true);
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.invoke).toHaveBeenCalledTimes(count);
  });

  it('serializes a release behind an in-flight lease and tolerates missing endpoint control', async () => {
    const f = fixture();
    let finish!: (value: unknown) => void;
    f.invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    f.ducking.set(true);
    await vi.advanceTimersByTimeAsync(0);
    f.ducking.set(false);
    expect(f.invoke).toHaveBeenCalledOnce();
    finish(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.values()).toEqual([
      { version: 1, active: true },
      { version: 1, active: false },
    ]);
    f.invoke.mockRejectedValueOnce('unavailable');
    f.ducking.set(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.values().at(-1)).toEqual({ version: 1, active: true });
    f.ducking.dispose();
    await vi.advanceTimersByTimeAsync(0);
  });
});
