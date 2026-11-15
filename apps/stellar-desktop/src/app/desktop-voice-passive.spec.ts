import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  AudioActivityService,
  type AudioActivityState,
  type PcmEvent,
} from '@stellar/service-audio-activity';
import {
  IvyAdapterService,
  IvyReflexService,
  SpeechAdapterService,
  PromptCleanupService,
  initialIvySnapshot,
  initialSpeechSnapshot,
} from '@stellar/service-desktop-adapter';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesktopAssistant } from './desktop-assistant';
import { DesktopExperience } from './desktop-experience';
import { DesktopVoice } from './desktop-voice';

async function fixture() {
  let receive!: (event: PcmEvent) => void;
  let release!: () => void;
  let active = false;
  let sequence = 0;
  let heldPcm!: Int16Array;
  const pending = new Promise<void>((resolve) => (release = resolve));
  const audio = signal<AudioActivityState>({
    status: 'capturing',
    activity: {
      active: false,
      calibrating: false,
      level: 0.1,
      peakLevel: 0.1,
      durationMs: 0,
      noiseFloor: 0.001,
      clipped: false,
    },
  });
  const speech = {
    keywordsAvailable: true,
    state: signal(initialSpeechSnapshot()),
    setDucking: vi.fn(),
    stop: vi.fn(async () => {
      speech.state.set(initialSpeechSnapshot());
    }),
    keywords: vi.fn(async (_pcm, _stream, sequence: number) => ({
      sequence,
      detection: null,
    })),
    collect: vi.fn(async (pcm: Int16Array, utterance_id: string) => {
      if (active) throw new Error('SpeechHost busy');
      active = true;
      heldPcm = pcm;
      speech.state.set({
        ...initialSpeechSnapshot(),
        operation_id: utterance_id,
        state: 'collecting',
      });
      try {
        await pending;
        return { version: 1, utterance_id, text: 'Ambient private speech' };
      } finally {
        active = false;
        // The native idle event may reach the Angular effect after the reply.
      }
    }),
  };
  const assertReleased = () => {
    expect(active).toBe(false);
    return true;
  };
  const assistant = {
    state: signal({ ...initialIvySnapshot(), connection: 'ready' as const }),
    submit: vi.fn(async () => assertReleased()),
  };
  const ivy = {
    snapshot: vi.fn(async () => initialIvySnapshot()),
    newSession: vi.fn(async () => assertReleased()),
  };
  TestBed.configureTestingModule({
    providers: [
      DesktopVoice,
      { provide: IvyAdapterService, useValue: ivy },
      { provide: PromptCleanupService, useValue: {} },
      {
        provide: AudioActivityService,
        useValue: {
          state: audio,
          subscribePcm: (callback: (event: PcmEvent) => void) => {
            receive = callback;
            return () => undefined;
          },
        },
      },
      { provide: SpeechAdapterService, useValue: speech },
      { provide: DesktopAssistant, useValue: assistant },
      {
        provide: IvyReflexService,
        useValue: {
          localAvailable: () => false,
          run: vi.fn(async () => {
            assertReleased();
            return { handled: false };
          }),
          cancel: vi.fn(),
          reply: signal(''),
        },
      },
      {
        provide: DesktopExperience,
        useValue: {
          state: signal({ phase: 'idle' }),
          setPassiveListening: vi.fn(),
        },
      },
    ],
  });
  const voice = TestBed.inject(DesktopVoice);
  await vi.waitFor(() => expect(ivy.snapshot).toHaveBeenCalledOnce());
  await Promise.resolve();
  voice.setShowRecognition(true);
  TestBed.tick();
  const ambient = () => {
    for (const [active, count] of [
      [true, 8],
      [false, 35],
    ] as const) {
      audio.update((state) => ({
        ...state,
        activity: { ...state.activity, active },
      }));
      TestBed.tick();
      for (let i = 0; i < count; i++)
        receive({
          type: 'chunk',
          chunk: {
            sampleRate: 16000,
            sequence: sequence++,
            samples: new Int16Array(640).fill(active ? 2000 : 0),
          },
        });
    }
    TestBed.tick();
  };
  ambient();
  expect(speech.collect).toHaveBeenCalledOnce();
  return {
    voice,
    assistant,
    ivy,
    speech,
    release,
    receive,
    ambient,
    pcm: () => heldPcm,
  };
}

describe('desktop operations during passive diagnostics', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    localStorage.removeItem('stellar.voice.showRecognition');
    localStorage.removeItem('stellar.voice.wakeSensitivity');
  });

  it('accepts typed Send once after its owned passive collect releases, despite a lagging idle event', async () => {
    const f = await fixture();
    const accepted = f.voice.submitText('Please check my schedule');
    expect(await f.voice.submitText('Duplicate click')).toBe(false);
    f.ambient();
    expect(f.speech.collect).toHaveBeenCalledOnce();
    expect(f.assistant.submit).not.toHaveBeenCalled();
    f.release();
    expect(await accepted).toBe(true);
    expect(f.assistant.submit).toHaveBeenCalledExactlyOnceWith(
      'Please check my schedule',
      expect.any(String),
    );
    expect(f.voice.state().foregroundActive).toBe(true);
    expect(f.voice.recognition()).toBeNull();
    expect(f.pcm().every((sample) => sample === 0)).toBe(true);
  });

  it('starts a new session once after the owned passive collect releases', async () => {
    const f = await fixture();
    const accepted = f.voice.newSession();
    expect(f.ivy.newSession).not.toHaveBeenCalled();
    f.release();
    expect(await accepted).toBe(true);
    expect(f.ivy.newSession).toHaveBeenCalledOnce();
    expect(f.assistant.submit).not.toHaveBeenCalled();
    expect(f.voice.recognition()).toBeNull();
  });

  it.each(['collecting', 'transcribing', 'speaking'] as const)(
    'rejects a new %s owner that appears before passive collection releases',
    async (state) => {
      const f = await fixture();
      const accepted = f.voice.submitText('Do not overlap the new owner');
      f.speech.state.set({
        ...initialSpeechSnapshot(),
        operation_id: 'a-different-foreground-operation',
        state,
      });
      TestBed.tick();
      f.release();
      expect(await accepted).toBe(false);
      expect(f.assistant.submit).not.toHaveBeenCalled();
      expect(f.voice.recognition()).toBeNull();
    },
  );

  it('rejects a changed speech epoch instead of treating an old operation ID as ownership', async () => {
    const f = await fixture();
    const accepted = f.voice.submitText('Do not send across epochs');
    f.speech.state.update((state) => ({ ...state, epoch: '1' }));
    TestBed.tick();
    f.release();
    expect(await accepted).toBe(false);
    expect(f.assistant.submit).not.toHaveBeenCalled();
  });

  it('does not submit if Ivy becomes busy while the owned passive collect releases', async () => {
    const f = await fixture();
    const accepted = f.voice.submitText('Do not overlap another Ivy request');
    f.assistant.state.update((state) => ({ ...state, turn: 'admitted' }));
    TestBed.tick();
    f.release();
    expect(await accepted).toBe(false);
    expect(f.assistant.submit).not.toHaveBeenCalled();
  });

  it.each(['reset', 'dispose'] as const)(
    'cancels typed Send waiting for passive collect on %s without late submission',
    async (operation) => {
      const f = await fixture();
      const accepted = f.voice.submitText('Must never send');
      if (operation === 'reset') f.receive({ type: 'reset' });
      else TestBed.resetTestingModule();
      expect(await accepted).toBe(false);
      f.release();
      await vi.waitFor(() =>
        expect(f.pcm().every((sample) => sample === 0)).toBe(true),
      );
      expect(f.assistant.submit).not.toHaveBeenCalled();
      expect(f.ivy.newSession).not.toHaveBeenCalled();
      expect(f.voice.recognition()).toBeNull();
    },
  );
});
