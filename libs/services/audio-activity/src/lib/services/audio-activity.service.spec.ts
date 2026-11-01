import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { NgZone } from '@angular/core';
import { AudioActivityService } from './audio-activity.service';
import { SyntheticAudioSource } from '../synthetic-audio-source';

describe('AudioActivityService', () => {
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
