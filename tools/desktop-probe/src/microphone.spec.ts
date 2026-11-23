import { afterEach, describe, expect, it, vi } from 'vitest';
import { MicrophoneProbe } from './microphone.js';

function fixture() {
  const track = new EventTarget() as EventTarget & {
    stop: ReturnType<typeof vi.fn>;
  };
  track.stop = vi.fn();
  Object.assign(track, {
    readyState: 'live',
    muted: false,
    label: 'Fixture input',
  });
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
  const close = vi.fn(async () => undefined);
  const disconnect = vi.fn();
  const sourceDisconnect = vi.fn();
  const audio = Object.assign(new EventTarget(), {
    state: 'running',
    sampleRate: 48000,
    resume: async () => undefined,
    close,
    createMediaStreamSource: () => ({
      connect: vi.fn(),
      disconnect: sourceDisconnect,
    }),
    createAnalyser: () => ({
      fftSize: 1024,
      disconnect,
      getFloatTimeDomainData: (buffer: Float32Array) => buffer.fill(0.04),
    }),
  }) as unknown as AudioContext;
  const update = vi.fn();
  const acquire = vi.fn(async () => stream);
  return {
    track,
    stream,
    close,
    update,
    acquire,
    audio,
    disconnect,
    sourceDisconnect,
    probe: new MicrophoneProbe(update, { acquire, audio: () => audio }),
  };
}

afterEach(() => vi.useRealTimers());

describe('opt-in microphone resource ownership', () => {
  it('acquires nothing before start, samples only while active and releases on stop', async () => {
    vi.useFakeTimers();
    const f = fixture();
    expect(f.acquire).not.toHaveBeenCalled();
    await f.probe.start();
    await f.probe.start();
    expect(f.acquire).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(67);
    expect(f.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'running',
        rms: expect.closeTo(0.04),
        peak: expect.closeTo(0.04),
        dbfs: expect.closeTo(-27.96, 2),
        frames: 1,
        context: 'running',
        track: 'live',
        muted: false,
        input: 'Fixture input',
      }),
    );
    await f.probe.stop();
    expect(f.track.stop).toHaveBeenCalledTimes(1);
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.sourceDisconnect).toHaveBeenCalledTimes(1);
    expect(f.disconnect).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('stops a permission result that arrives after cancellation', async () => {
    const f = fixture();
    let grant: (stream: MediaStream) => void = () => undefined;
    const pending = new Promise<MediaStream>((resolve) => {
      grant = resolve;
    });
    const audio = vi.fn(() => f.audio);
    const probe = new MicrophoneProbe(f.update, {
      acquire: () => pending,
      audio,
    });
    const starting = probe.start();
    await probe.stop();
    grant(f.stream);
    await starting;
    expect(f.track.stop).toHaveBeenCalledTimes(1);
    expect(audio).toHaveBeenCalledTimes(1);
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'idle',
        rms: 0,
        context: 'absent',
        track: 'absent',
      }),
    );
  });
  it('reports deny, no-device and unavailable failures without retaining capture', async () => {
    for (const [name, status] of [
      ['NotAllowedError', 'denied'],
      ['NotFoundError', 'no-device'],
      ['NotReadableError', 'unavailable'],
    ]) {
      const f = fixture();
      const error = new Error('fixture');
      error.name = name ?? '';
      const probe = new MicrophoneProbe(f.update, {
        acquire: async () => {
          throw error;
        },
        audio: () => f.audio,
      });
      await probe.start();
      expect(f.update).toHaveBeenLastCalledWith(
        expect.objectContaining({ status, rms: 0 }),
      );
      expect(f.close).toHaveBeenCalledTimes(1);
    }
  });
  it('releases tracks when audio initialization fails or the device disconnects', async () => {
    const failed = fixture();
    const probe = new MicrophoneProbe(failed.update, {
      acquire: failed.acquire,
      audio: () => {
        throw new Error('audio unavailable');
      },
    });
    await probe.start();
    expect(failed.acquire).not.toHaveBeenCalled();
    const f = fixture();
    await f.probe.start();
    f.track.dispatchEvent(new Event('ended'));
    expect(f.track.stop).toHaveBeenCalledTimes(1);
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'device-ended', rms: 0 }),
    );
  });
  it('resumes in the start gesture, exposes suspension and keeps selected input private', async () => {
    vi.useFakeTimers();
    const f = fixture();
    Object.assign(f.audio, {
      state: 'suspended',
      resume: vi.fn(async () => undefined),
    });
    f.acquire.mockImplementation(async () => {
      expect(f.audio.resume).toHaveBeenCalledTimes(1);
      return f.stream;
    });
    await f.probe.start('private-device-identifier');
    expect(f.acquire).toHaveBeenCalledWith('private-device-identifier');
    expect(f.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'suspended', context: 'suspended' }),
    );
    await f.probe.start();
    expect(f.acquire).toHaveBeenCalledTimes(1);
    Object.assign(f.audio, { state: 'running' });
    await f.probe.resume();
    expect(f.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'running' }),
    );
    Object.assign(f.track, { muted: true });
    f.track.dispatchEvent(new Event('mute'));
    expect(f.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ muted: true }),
    );
    expect(JSON.stringify(f.update.mock.calls)).not.toContain(
      'private-device-identifier',
    );
    await f.probe.stop();
  });
  it('retains low-level samples and represents digital silence without a false activity floor', async () => {
    vi.useFakeTimers();
    const f = fixture();
    let sample = 0.00001;
    Object.assign(f.audio, {
      createAnalyser: () => ({
        fftSize: 1024,
        disconnect: vi.fn(),
        getFloatTimeDomainData: (buffer: Float32Array) => buffer.fill(sample),
      }),
    });
    await f.probe.start();
    vi.advanceTimersByTime(67);
    expect(f.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        rms: expect.closeTo(sample, 8),
        dbfs: expect.closeTo(-100),
      }),
    );
    sample = 0;
    vi.advanceTimersByTime(67);
    expect(f.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ rms: 0, peak: 0, dbfs: null, frames: 2 }),
    );
    await f.probe.stop();
  });
});
