import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  AudioActivityService,
  AudioActivityController,
  type AudioSink,
  type AudioActivityState,
} from '@stellar/service-audio-activity';
import { describe, expect, it, vi } from 'vitest';
import { DesktopExperience } from './desktop-experience';

describe('desktop experience status', () => {
  it('selects without capture, then stops the active source before changing input', async () => {
    const calls: string[] = [];
    const current = signal<AudioActivityState>({
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
      setContinuousCapture: vi.fn(),
      state: current,
      listInputs: async () => [
        { deviceId: 'usb', label: 'USB mic' },
        { deviceId: 'built-in', label: 'Built-in' },
      ],
      startMicrophone: vi.fn(async (deviceId?: string) => {
        calls.push(`start:${deviceId}`);
        current.update((state) => ({ ...state, status: 'capturing' }));
      }),
      stop: vi.fn(async () => {
        calls.push('stop');
        current.update((state) => ({ ...state, status: 'idle' }));
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
    await experience.inputs.list();
    experience.selectInput('usb');
    expect(audio.startMicrophone).not.toHaveBeenCalled();
    experience.dispatch({ type: 'capture-request' });
    TestBed.tick();
    experience.selectInput('built-in');
    TestBed.tick();
    expect(calls).toEqual(['start:usb', 'stop', 'start:built-in']);
    expect(experience.inputs.selectedLabel()).toBe('Built-in');
    window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new Event('focus'));
    TestBed.tick();
    expect(experience.statusText()).toBe('Microphone on');
    expect(audio.startMicrophone).toHaveBeenCalledTimes(2);
    TestBed.resetTestingModule();
  });
  it('retains a late microphone grant through focus loss and stops only on explicit shutdown', async () => {
    let grant!: () => void;
    const acquire = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          grant = resolve;
        }),
    );
    const trackStop = vi.fn();
    const source = {
      async start(sink: AudioSink) {
        await acquire();
        sink.status('capturing');
      },
      async stop() {
        trackStop();
      },
    };
    const controller = new AudioActivityController((next) => current.set(next));
    const current = signal(controller.snapshot());
    const audio = {
      setContinuousCapture: vi.fn(),
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
    expect(experience.state().phase).toBe('idle');
    grant();
    await vi.waitFor(() => expect(current().status).not.toBe('requesting'));
    expect(trackStop).not.toHaveBeenCalled();
    experience.dispatch({ type: 'shutdown' });
    await vi.waitFor(() => expect(trackStop).toHaveBeenCalledOnce());
    window.dispatchEvent(new Event('focus'));
    TestBed.tick();
    expect(experience.state().phase).toBe('shutdown');
    expect(experience.state().microphone.status).toBe('stopped');
    expect(acquire).toHaveBeenCalledOnce();
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
      setContinuousCapture: vi.fn(),
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
