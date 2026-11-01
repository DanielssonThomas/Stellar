import { describe, expect, it, vi } from 'vitest';
import { WebAudioSource } from './web-audio-source';
import type { AudioSink } from './audio-model';

function fixture() {
  const track = Object.assign(new EventTarget(), {
    readyState: 'live',
    muted: false,
    stop: vi.fn(),
  });
  const extra = { stop: vi.fn() };
  const stream = {
    getTracks: () => [track, extra],
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
  const source = { connect: vi.fn(), disconnect: vi.fn() };
  let value = 0.1;
  const analyser = {
    fftSize: 0,
    disconnect: vi.fn(),
    getFloatTimeDomainData: vi.fn((buffer: Float32Array) => buffer.fill(value)),
  };
  const context = Object.assign(new EventTarget(), {
    state: 'running',
    resume: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    createMediaStreamSource: vi.fn(() => source),
    createAnalyser: vi.fn(() => analyser),
  });
  const addTrack = vi.spyOn(track, 'addEventListener');
  const removeTrack = vi.spyOn(track, 'removeEventListener');
  const addContext = vi.spyOn(context, 'addEventListener');
  const removeContext = vi.spyOn(context, 'removeEventListener');
  const acquire = vi.fn(async () => stream);
  const audio = vi.fn(() => context as unknown as AudioContext);
  const cancel = vi.fn();
  let sample: () => void = () => undefined;
  const sink: AudioSink = { frame: vi.fn(), status: vi.fn() };
  const capture = new WebAudioSource({
    acquire,
    audio,
    now: () => 100,
    schedule: (callback) => {
      sample = callback;
      return cancel;
    },
  });
  return {
    capture,
    sink,
    acquire,
    audio,
    context,
    track,
    extra,
    stream,
    source,
    analyser,
    cancel,
    addTrack,
    removeTrack,
    addContext,
    removeContext,
    sample: () => sample(),
    level: (next: number) => {
      value = next;
    },
  };
}

describe('opt-in Web Audio source', () => {
  it('releases capture even when a terminal status subscriber throws', async () => {
    const f = fixture();
    await f.capture.start({
      frame: f.sink.frame,
      status: (status) => {
        if (status === 'idle') throw Error('subscriber failed');
      },
    });
    await expect(f.capture.stop()).rejects.toThrow('subscriber failed');
    await f.capture.stop();
    for (const resource of [
      f.cancel,
      f.source.disconnect,
      f.analyser.disconnect,
      f.track.stop,
      f.extra.stop,
      f.context.close,
    ])
      expect(resource).toHaveBeenCalledTimes(1);
    expect(f.removeTrack.mock.calls).toEqual(f.addTrack.mock.calls);
    expect(f.removeContext.mock.calls).toEqual(f.addContext.mock.calls);
    f.sample();
    expect(f.sink.frame).not.toHaveBeenCalled();
  });
  it('does not acquire before start, resumes within the gesture, emits only bounded summaries and releases all resources', async () => {
    const f = fixture();
    expect(f.acquire).not.toHaveBeenCalled();
    f.acquire.mockImplementation(async () => {
      expect(f.context.resume).toHaveBeenCalledTimes(1);
      return f.stream;
    });
    await f.capture.start(f.sink, 'private-input');
    expect(f.acquire).toHaveBeenCalledWith('private-input');
    expect(f.sink.status).toHaveBeenLastCalledWith('capturing');
    f.sample();
    expect(f.sink.frame).toHaveBeenCalledWith({
      timestampMs: 100,
      rms: expect.closeTo(0.1),
      peak: expect.closeTo(0.1),
      clipped: false,
    });
    expect(JSON.stringify(vi.mocked(f.sink.frame).mock.calls)).not.toContain(
      'private-input',
    );
    f.level(3);
    f.sample();
    expect(f.sink.frame).toHaveBeenLastCalledWith({
      timestampMs: 100,
      rms: 1,
      peak: 1,
      clipped: true,
    });
    f.level(NaN);
    f.sample();
    expect(f.sink.frame).toHaveBeenCalledTimes(2);
    await f.capture.stop();
    await f.capture.stop();
    expect(f.cancel).toHaveBeenCalledTimes(1);
    for (const resource of [
      f.source.disconnect,
      f.analyser.disconnect,
      f.track.stop,
      f.extra.stop,
      f.context.close,
    ])
      expect(resource).toHaveBeenCalledTimes(1);
    expect(f.removeTrack.mock.calls).toEqual(f.addTrack.mock.calls);
    expect(f.removeContext.mock.calls).toEqual(f.addContext.mock.calls);
    f.sample();
    expect(f.sink.frame).toHaveBeenCalledTimes(2);
  });

  it('stops late permission tracks after cancellation or source replacement', async () => {
    const old = fixture();
    let resolve: (stream: MediaStream) => void = () => undefined;
    old.acquire.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const starting = old.capture.start(old.sink);
    await old.capture.stop();
    const next = fixture();
    old.acquire.mockResolvedValueOnce(next.stream);
    await old.capture.start(next.sink);
    resolve(old.stream);
    await starting;
    expect(old.track.stop).toHaveBeenCalledTimes(1);
    expect(old.extra.stop).toHaveBeenCalledTimes(1);
    expect(next.track.stop).not.toHaveBeenCalled();
    await old.capture.stop();
    expect(next.track.stop).toHaveBeenCalledTimes(1);
  });

  it('maps denial, missing device and unavailable acquisition without retaining contexts', async () => {
    for (const [name, status] of [
      ['NotAllowedError', 'denied'],
      ['NotFoundError', 'missing'],
      ['OverconstrainedError', 'missing'],
      ['NotReadableError', 'unavailable'],
    ]) {
      const f = fixture();
      f.acquire.mockRejectedValueOnce({ name });
      await f.capture.start(f.sink);
      expect(f.sink.status).toHaveBeenLastCalledWith(status);
      expect(f.context.close).toHaveBeenCalledTimes(1);
      expect(f.analyser.getFloatTimeDomainData).not.toHaveBeenCalled();
    }
  });

  it('reports suspension without samples and releases when resume rejects', async () => {
    const f = fixture();
    f.context.state = 'suspended';
    await f.capture.start(f.sink);
    f.sample();
    expect(f.sink.status).toHaveBeenLastCalledWith('suspended');
    expect(f.sink.frame).not.toHaveBeenCalled();
    f.context.state = 'running';
    f.context.dispatchEvent(new Event('statechange'));
    f.sample();
    expect(f.sink.status).toHaveBeenLastCalledWith('capturing');
    expect(f.sink.frame).toHaveBeenCalledTimes(1);
    await f.capture.stop();
    const rejected = fixture();
    rejected.context.resume.mockRejectedValueOnce(new Error('unavailable'));
    await rejected.capture.start(rejected.sink);
    expect(rejected.sink.status).toHaveBeenLastCalledWith('unavailable');
    expect(rejected.context.close).toHaveBeenCalledTimes(1);
    expect(rejected.track.stop).toHaveBeenCalledTimes(1);
  });

  it('cleans up on disconnect, mute, missing tracks, graph failure and sampler failure', async () => {
    for (const [event, status] of [
      ['ended', 'disconnected'],
      ['mute', 'muted'],
    ]) {
      const f = fixture();
      await f.capture.start(f.sink);
      f.track.dispatchEvent(new Event(event));
      expect(f.sink.status).toHaveBeenLastCalledWith(status);
      expect(f.track.stop).toHaveBeenCalledTimes(1);
      expect(f.cancel).toHaveBeenCalledTimes(1);
    }
    const missing = fixture();
    vi.spyOn(missing.stream, 'getAudioTracks').mockReturnValue([]);
    await missing.capture.start(missing.sink);
    expect(missing.sink.status).toHaveBeenLastCalledWith('missing');
    expect(missing.extra.stop).toHaveBeenCalledTimes(1);
    const graph = fixture();
    graph.context.createAnalyser.mockImplementation(() => {
      throw Error('graph');
    });
    await graph.capture.start(graph.sink);
    expect(graph.sink.status).toHaveBeenLastCalledWith('unavailable');
    expect(graph.source.disconnect).toHaveBeenCalledTimes(1);
    expect(graph.track.stop).toHaveBeenCalledTimes(1);
    const sample = fixture();
    await sample.capture.start(sample.sink);
    sample.analyser.getFloatTimeDomainData.mockImplementation(() => {
      throw Error('sample');
    });
    sample.sample();
    expect(sample.sink.status).toHaveBeenLastCalledWith('unavailable');
    expect(sample.track.stop).toHaveBeenCalledTimes(1);
  });

  it('ignores late callbacks and continues releasing after individual cleanup failures', async () => {
    const f = fixture();
    await f.capture.start(f.sink);
    const oldEnded = f.addTrack.mock.calls.find(
      ([name]) => name === 'ended',
    )?.[1] as EventListener;
    f.source.disconnect.mockImplementation(() => {
      throw Error('already closed');
    });
    f.track.stop.mockImplementation(() => {
      throw Error('already stopped');
    });
    f.context.close.mockRejectedValueOnce(Error('closed'));
    await expect(f.capture.stop()).resolves.toBeUndefined();
    oldEnded(new Event('ended'));
    expect(f.sink.status).toHaveBeenLastCalledWith('idle');
    expect(f.extra.stop).toHaveBeenCalledTimes(1);
    expect(f.analyser.disconnect).toHaveBeenCalledTimes(1);
  });
});
