import { describe, expect, it, vi } from 'vitest';
import { AudioActivityController } from './audio-activity-controller';
import { SyntheticAudioSource } from './synthetic-audio-source';
import type { AudioSink, AudioSource } from './audio-model';

function fixtureSource() {
  let sink: AudioSink | undefined;
  const source: AudioSource = {
    start: vi.fn(async (next) => {
      sink = next;
      next.status('capturing');
    }),
    stop: vi.fn(async () => {
      sink?.status('idle');
    }),
  };
  return {
    source,
    sink: () => {
      if (!sink) throw Error('not started');
      return sink;
    },
  };
}

describe('audio lifecycle owner', () => {
  it.each(['start', 'stop'] as const)(
    'preserves a replacement started synchronously by cleanup during %s',
    async (action) => {
      const owner = new AudioActivityController(() => undefined);
      const first = fixtureSource();
      const obsolete = fixtureSource();
      const replacement = fixtureSource();
      await owner.start(first.source);
      vi.mocked(first.source.stop).mockImplementationOnce(async () => {
        void owner.start(replacement.source);
      });
      if (action === 'start') await owner.start(obsolete.source);
      else await owner.stop();
      expect(obsolete.source.start).not.toHaveBeenCalled();
      expect(replacement.source.start).toHaveBeenCalledTimes(1);
      expect(replacement.source.stop).not.toHaveBeenCalled();
      expect(owner.snapshot().status).toBe('capturing');
      await owner.dispose();
    },
  );
  it.each(['stop', 'dispose'] as const)(
    'does not launch capture after a requesting listener calls %s',
    async (action) => {
      const source = fixtureSource();
      const owner = new AudioActivityController((state) => {
        if (state.status === 'requesting') void owner[action]();
      });
      await owner.start(source.source);
      expect(source.source.start).not.toHaveBeenCalled();
      expect(source.source.stop).toHaveBeenCalledTimes(1);
      expect(owner.snapshot().status).toBe('idle');
    },
  );

  it('launches only the replacement chosen by a synchronous requesting listener', async () => {
    const first = fixtureSource();
    const replacement = fixtureSource();
    let replaced = false;
    const owner = new AudioActivityController((state) => {
      if (state.status === 'requesting' && !replaced) {
        replaced = true;
        void owner.start(replacement.source);
      }
    });
    await owner.start(first.source);
    expect(first.source.start).not.toHaveBeenCalled();
    expect(first.source.stop).toHaveBeenCalledTimes(1);
    expect(replacement.source.start).toHaveBeenCalledTimes(1);
    expect(replacement.source.stop).not.toHaveBeenCalled();
    expect(owner.snapshot().status).toBe('capturing');
    await owner.dispose();
    expect(replacement.source.stop).toHaveBeenCalledTimes(1);
  });

  it('releases the old session before a terminal listener restarts the same source', async () => {
    const source = new SyntheticAudioSource();
    let restart = false;
    const owner = new AudioActivityController(
      (state) => {
        if (state.status === 'idle' && restart) {
          restart = false;
          void owner.start(source);
        }
      },
      { calibrationMs: 0, minActiveMs: 0 },
    );
    await owner.start(source);
    restart = true;
    await owner.stop();
    source.push({ timestampMs: 0, rms: 0, peak: 0, clipped: false });
    source.push({ timestampMs: 30, rms: 0.1, peak: 0.1, clipped: false });
    expect(owner.snapshot()).toMatchObject({
      status: 'capturing',
      activity: { active: true },
    });
    await owner.dispose();
  });
  it('clears activity on audio-context suspension and requires fresh activity after resume', async () => {
    const owner = new AudioActivityController(() => undefined, {
      calibrationMs: 0,
    });
    const source = fixtureSource();
    await owner.start(source.source);
    source.sink().frame({ timestampMs: 0, rms: 0, peak: 0, clipped: false });
    for (let timestampMs = 30; timestampMs <= 180; timestampMs += 30)
      source.sink().frame({ timestampMs, rms: 0.1, peak: 0.1, clipped: false });
    expect(owner.snapshot().activity.active).toBe(true);
    source.sink().status('suspended');
    expect(owner.snapshot()).toMatchObject({
      status: 'suspended',
      activity: { active: false, level: 0 },
    });
    source.sink().status('capturing');
    source
      .sink()
      .frame({ timestampMs: 210, rms: 0.1, peak: 0.1, clipped: false });
    expect(owner.snapshot().activity.active).toBe(false);
    await owner.dispose();
  });
  it('bounds visual levels to 20 Hz while detecting every frame and preserving summaries on stop', async () => {
    const changed = vi.fn();
    const owner = new AudioActivityController(changed, {
      calibrationMs: 0,
      minActiveMs: 0,
    });
    const source = new SyntheticAudioSource();
    await owner.start(source);
    source.push({ timestampMs: 0, rms: 0, peak: 0, clipped: false });
    source.push({ timestampMs: 1, rms: 0.1, peak: 0.3, clipped: false });
    changed.mockClear();
    for (let timestampMs = 2; timestampMs <= 1001; timestampMs++)
      source.push({ timestampMs, rms: 0.1, peak: 0.3, clipped: false });
    expect(changed).toHaveBeenCalledTimes(20);
    expect(owner.snapshot().activity).toMatchObject({
      active: true,
      durationMs: 1000,
    });
    await owner.stop();
    expect(owner.snapshot()).toMatchObject({
      status: 'idle',
      activity: { active: false, level: 0, durationMs: 1000 },
    });
    expect(Object.isFrozen(owner.snapshot().activity)).toBe(true);
  });

  it('invalidates old source callbacks, permission results and failed starts during source switch', async () => {
    const owner = new AudioActivityController(() => undefined);
    const first = fixtureSource();
    const second = fixtureSource();
    await owner.start(first.source);
    const stale = first.sink();
    await owner.start(second.source);
    expect(first.source.stop).toHaveBeenCalledTimes(1);
    stale.status('denied');
    stale.frame({ timestampMs: 9000, rms: 1, peak: 1, clipped: true });
    expect(owner.snapshot()).toMatchObject({
      status: 'capturing',
      activity: { peakLevel: 0 },
    });
    await owner.stop('muted');
    second.sink().status('capturing');
    expect(owner.snapshot().status).toBe('muted');
    expect(second.source.stop).toHaveBeenCalledTimes(1);
    await owner.start({
      start: async () => {
        throw Error('failed');
      },
      stop: async () => undefined,
    });
    expect(owner.snapshot().status).toBe('unavailable');
  });

  it('releases on hidden/pagehide/minimize and removes listeners on disposal without automatic restart', async () => {
    const owner = new AudioActivityController(() => undefined);
    const source = fixtureSource();
    const doc = Object.assign(new EventTarget(), { hidden: false });
    const win = new EventTarget();
    const removeDoc = vi.spyOn(doc, 'removeEventListener');
    const removeWin = vi.spyOn(win, 'removeEventListener');
    owner.bindLifecycle(doc as unknown as Document, win as unknown as Window);
    await owner.start(source.source);
    doc.hidden = true;
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(source.source.stop).toHaveBeenCalledTimes(1);
    expect(owner.snapshot().status).toBe('suspended');
    doc.hidden = false;
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(source.source.start).toHaveBeenCalledTimes(1);
    await owner.start(source.source);
    win.dispatchEvent(new Event('pagehide'));
    expect(source.source.stop).toHaveBeenCalledTimes(2);
    await owner.start(source.source);
    await owner.suspend();
    expect(source.source.stop).toHaveBeenCalledTimes(3);
    await owner.dispose();
    expect(removeDoc).toHaveBeenCalledTimes(1);
    expect(removeWin).toHaveBeenCalledTimes(1);
    await owner.start(source.source);
    expect(source.source.start).toHaveBeenCalledTimes(3);
  });

  it('synthetic/manual input needs no browser permission and stops synchronously', async () => {
    const owner = new AudioActivityController(() => undefined, {
      calibrationMs: 0,
      minActiveMs: 0,
    });
    const source = new SyntheticAudioSource();
    await owner.start(source);
    source.push({ timestampMs: 0, rms: 0, peak: 0, clipped: false });
    source.push({ timestampMs: 30, rms: 0.1, peak: 0.1, clipped: false });
    expect(owner.snapshot().activity.active).toBe(true);
    const stopping = owner.stop();
    source.push({ timestampMs: 60, rms: 1, peak: 1, clipped: true });
    await stopping;
    expect(owner.snapshot().activity.active).toBe(false);
    await owner.start(source);
    await owner.dispose();
    source.push({ timestampMs: 90, rms: 1, peak: 1, clipped: true });
    expect(owner.snapshot().status).toBe('idle');
  });
});
