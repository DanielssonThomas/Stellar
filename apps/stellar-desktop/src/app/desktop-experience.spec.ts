import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  AudioActivityService,
  AudioActivityController,
  WebAudioSource,
  type AudioActivityState,
} from '@stellar/service-audio-activity';
import { describe, expect, it, vi } from 'vitest';
import { DesktopExperience } from './desktop-experience';

describe('desktop experience status', () => {
  it('releases a late microphone grant after suspension and resumes only manual activity', async () => {
    let grant: (stream: MediaStream) => void = () => undefined;
    const acquire = vi.fn(
      () =>
        new Promise<MediaStream>((resolve) => {
          grant = resolve;
        }),
    );
    const trackStop = vi.fn();
    const close = vi.fn(async () => undefined);
    const source = new WebAudioSource({
      acquire,
      audio: () =>
        ({
          resume: async () => undefined,
          close,
          state: 'running',
        }) as unknown as AudioContext,
    });
    const controller = new AudioActivityController((next) => current.set(next));
    const current = signal(controller.snapshot());
    const audio = {
      state: current,
      startMicrophone: vi.fn(() => controller.start(source)),
      stop: vi.fn(() => controller.stop()),
    };
    TestBed.configureTestingModule({
      providers: [
        DesktopExperience,
        { provide: AudioActivityService, useValue: audio },
      ],
    });
    const experience = TestBed.inject(DesktopExperience);
    TestBed.tick();
    experience.dispatch({ type: 'capture-request' });
    TestBed.tick();
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledOnce());
    window.dispatchEvent(new Event('blur'));
    expect(experience.state().phase).toBe('suspended');
    grant({ getTracks: () => [{ stop: trackStop }] } as unknown as MediaStream);
    await vi.waitFor(() => expect(trackStop).toHaveBeenCalledOnce());
    expect(close).toHaveBeenCalledOnce();
    window.dispatchEvent(new Event('focus'));
    TestBed.tick();
    expect(experience.state().phase).toBe('idle');
    expect(experience.state().microphone.status).toBe('stopped');
    expect(acquire).toHaveBeenCalledOnce();
    experience.dispatch({ type: 'manual-start' });
    expect(experience.state().manualActive).toBe(true);
    TestBed.resetTestingModule();
    expect(current().status).toBe('idle');
  });
  it('retains permission denial after capture cleanup resets the audio service', async () => {
    const state = signal<AudioActivityState>({
      status: 'idle',
      activity: {
        active: false,
        calibrating: false,
        level: 0,
        peakLevel: 0,
        durationMs: 0,
        noiseFloor: 0,
        clipped: false,
      },
    });
    const audio = {
      state,
      startMicrophone: vi.fn(async () => {
        state.update((value) => ({ ...value, status: 'denied' }));
      }),
      stop: vi.fn(async () => {
        state.update((value) => ({ ...value, status: 'idle' }));
      }),
    };
    TestBed.configureTestingModule({
      providers: [
        DesktopExperience,
        { provide: AudioActivityService, useValue: audio },
      ],
    });
    const experience = TestBed.inject(DesktopExperience);
    TestBed.tick();
    experience.dispatch({ type: 'capture-request' });
    TestBed.tick();
    await vi.waitFor(() => expect(audio.stop).toHaveBeenCalledOnce());
    TestBed.tick();
    expect(audio.state().status).toBe('idle');
    expect(experience.statusText()).toContain('Microphone permission denied');
    experience.dispatch({ type: 'manual-start' });
    expect(experience.state().manualActive).toBe(true);
    TestBed.resetTestingModule();
  });
});
