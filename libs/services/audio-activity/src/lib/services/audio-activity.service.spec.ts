import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { NgZone } from '@angular/core';
import { AudioActivityService } from './audio-activity.service';
import { SyntheticAudioSource } from '../synthetic-audio-source';
import type { AudioSink, AudioSource } from '../audio-model';
import type { PcmEvent } from '../pcm-model';

describe('AudioActivityService', () => {
  it('does not deliver an old chunk after a consumer synchronously stops capture', async () => {
    TestBed.configureTestingModule({ providers: [AudioActivityService] });
    const service = TestBed.inject(AudioActivityService);
    const sinks: AudioSink[] = [];
    service.subscribePcm((event) => {
      if (event.type === 'chunk') void service.stop();
    });
    const events: PcmEvent[] = [];
    service.subscribePcm((event) => events.push(event));
    await service.start({
      start: async (sink) => {
        sinks.push(sink);
      },
      stop: async () => undefined,
    });
    events.length = 0;
    const samples = new Int16Array(640).fill(12);
    sinks[0].pcm?.({
      type: 'chunk',
      chunk: { sampleRate: 16000, sequence: 0, samples },
    });
    expect(events).toEqual([{ type: 'reset' }]);
    expect(samples[0]).toBe(0);
    TestBed.resetTestingModule();
  });
  it('delivers isolated PCM subscriptions and resets on stop while rejecting replaced source callbacks', async () => {
    TestBed.configureTestingModule({ providers: [AudioActivityService] });
    const service = TestBed.inject(AudioActivityService);
    const sinks: AudioSink[] = [];
    const source = (): AudioSource => ({
      start: async (sink) => {
        sinks.push(sink);
        sink.status('capturing');
      },
      stop: vi.fn(async () => undefined),
    });
    const a: PcmEvent[] = [],
      b: PcmEvent[] = [];
    const stopA = service.subscribePcm((event) => {
      a.push(event);
      if (event.type === 'chunk') event.chunk.samples[0] = 999;
    });
    service.subscribePcm((event) => b.push(event));
    await service.start(source());
    const chunk = {
      sampleRate: 16000 as const,
      sequence: 0,
      samples: new Int16Array(640).fill(7),
    };
    sinks[0].pcm?.({ type: 'chunk', chunk });
    const received = b.at(-1);
    expect(received?.type === 'chunk' && received.chunk.samples[0]).toBe(7);
    expect(chunk.samples[0]).toBe(0);
    await service.start(source());
    a.length = 0;
    b.length = 0;
    sinks[0].pcm?.({ type: 'chunk', chunk });
    expect(b).toHaveLength(0);
    stopA();
    await service.stop();
    expect(a).toHaveLength(0);
    expect(b).toEqual([{ type: 'reset' }]);
    TestBed.resetTestingModule();
    b.length = 0;
    sinks[1].pcm?.({ type: 'chunk', chunk });
    expect(b).toHaveLength(0);
  });
  it('is injectable as a shared singleton', () => {
    TestBed.configureTestingModule({ providers: [AudioActivityService] });

    const first = TestBed.inject(AudioActivityService);
    const second = TestBed.inject(AudioActivityService);

    expect(first).toBeInstanceOf(AudioActivityService);
    expect(second).toBe(first);
  });
  it('runs capture outside Angular and disposes an owned source with its injector', async () => {
    TestBed.configureTestingModule({ providers: [AudioActivityService] });
    const zone = TestBed.inject(NgZone);
    const outside = vi.spyOn(zone, 'runOutsideAngular');
    const service = TestBed.inject(AudioActivityService);
    const source = new SyntheticAudioSource();
    const stop = vi.spyOn(source, 'stop');
    await service.start(source);
    expect(outside).toHaveBeenCalled();
    expect(service.state().status).toBe('capturing');
    await service.mute();
    expect(service.state().status).toBe('muted');
    await service.start(source);
    stop.mockClear();
    TestBed.resetTestingModule();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
