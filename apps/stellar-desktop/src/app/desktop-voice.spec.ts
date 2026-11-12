import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AudioActivityService } from '@stellar/service-audio-activity';
import {
  IvyAdapterService,
  SpeechAdapterService,
  PromptCleanupService,
  initialIvySnapshot,
  initialSpeechSnapshot,
} from '@stellar/service-desktop-adapter';
import { describe, expect, it, vi } from 'vitest';
import { DesktopAssistant } from './desktop-assistant';
import { DesktopExperience } from './desktop-experience';
import { DesktopVoice } from './desktop-voice';
import { DesktopSpatial } from './desktop-spatial';

function fixture(snapshot: ReturnType<typeof vi.fn>, slot?: Promise<void>) {
  const ivy = {
    snapshot,
    claimUpdate: vi.fn(async () => true),
    selectSession: vi.fn(async () => true),
    clearConversation: vi.fn(async () => true),
  };
  TestBed.configureTestingModule({
    providers: [
      DesktopVoice,
      ...(slot
        ? [
            {
              provide: DesktopSpatial,
              useValue: {
                whenQuiet: () => slot,
                ownsSpeech: () => false,
                setMuted: vi.fn(),
                interrupt: vi.fn(),
              },
            },
          ]
        : []),
      {
        provide: PromptCleanupService,
        useValue: {
          refine: vi.fn(async (raw: string) => ({
            raw,
            text: raw,
            status: 'fallback',
          })),
        },
      },
      { provide: IvyAdapterService, useValue: ivy },
      {
        provide: AudioActivityService,
        useValue: {
          state: signal({ status: 'idle' }),
          subscribePcm: () => () => undefined,
        },
      },
      {
        provide: SpeechAdapterService,
        useValue: {
          state: signal(initialSpeechSnapshot()),
          initialize: vi.fn(async () => undefined),
          setDucking: vi.fn(),
          stop: vi.fn(async () => undefined),
        },
      },
      {
        provide: DesktopAssistant,
        useValue: { state: signal(initialIvySnapshot()), submit: vi.fn() },
      },
      {
        provide: DesktopExperience,
        useValue: {
          state: signal({ phase: 'idle' }),
          startListening: vi.fn(),
          setPassiveListening: vi.fn(),
        },
      },
    ],
  });
  return { voice: TestBed.inject(DesktopVoice), ivy };
}

describe('desktop voice session composition', () => {
  it('cancels an update queued behind spatial speech without stopping the other speaker', async () => {
    let release!: () => void;
    const slot = new Promise<void>((done) => (release = done));
    const { voice, ivy } = fixture(
      vi.fn(async () => initialIvySnapshot()),
      slot,
    );
    const speech = TestBed.inject(SpeechAdapterService);
    const speak = vi.fn(async () => initialSpeechSnapshot());
    Object.assign(speech, { speak });
    const state = TestBed.inject(DesktopAssistant).state as WritableSignal<
      ReturnType<typeof initialIvySnapshot>
    >;
    await voice.refreshSession();
    state.set({
      ...initialIvySnapshot(),
      connection: 'ready',
      background_updates: [
        { id: 'update', text: 'Ready.', speech_claim: null },
      ],
    });
    TestBed.tick();
    for (let n = 0; n < 20; n++) await Promise.resolve();
    expect(ivy.claimUpdate).toHaveBeenCalledOnce();
    const speechState = speech.state as WritableSignal<
      ReturnType<typeof initialSpeechSnapshot>
    >;
    speechState.set({
      ...initialSpeechSnapshot(),
      revision: '1',
      state: 'speaking',
      operation_id: 'spatial-owner',
    });
    state.set({ ...state(), background_updates: [] });
    TestBed.tick();
    expect(speech.stop).not.toHaveBeenCalled();
    release();
    speechState.set({ ...initialSpeechSnapshot(), revision: '2' });
    TestBed.tick();
    for (let n = 0; n < 20; n++) await Promise.resolve();
    expect(speak).not.toHaveBeenCalled();
    TestBed.resetTestingModule();
  });

  it('stops its own background speech when reset precedes dispatch acknowledgement', async () => {
    const { voice } = fixture(vi.fn(async () => initialIvySnapshot()));
    const speech = TestBed.inject(SpeechAdapterService);
    const speechState = speech.state as WritableSignal<
      ReturnType<typeof initialSpeechSnapshot>
    >;
    let acknowledge!: () => void;
    const speak = vi.fn((_text: string, operation_id: string) => {
      const started = {
        ...initialSpeechSnapshot(),
        revision: '1',
        operation_id,
        state: 'synthesizing' as const,
      };
      speechState.set(started);
      return new Promise<ReturnType<typeof initialSpeechSnapshot>>(
        (done) => (acknowledge = () => done(started)),
      );
    });
    Object.assign(speech, { speak });
    const state = TestBed.inject(DesktopAssistant).state as WritableSignal<
      ReturnType<typeof initialIvySnapshot>
    >;
    await voice.refreshSession();
    state.set({
      ...initialIvySnapshot(),
      connection: 'ready',
      background_updates: [
        { id: 'update', text: 'Ready.', speech_claim: null },
      ],
    });
    TestBed.tick();
    for (let n = 0; n < 20; n++) await Promise.resolve();
    expect(speak).toHaveBeenCalledOnce();
    state.set({ ...state(), background_updates: [] });
    TestBed.tick();
    expect(speech.stop).toHaveBeenCalledOnce();
    speechState.set({ ...speechState(), revision: '2', state: 'idle' });
    TestBed.tick();
    acknowledge();
    for (let n = 0; n < 20; n++) await Promise.resolve();
    expect(speak).toHaveBeenCalledOnce();
    TestBed.resetTestingModule();
  });

  it('fences a committed response queued behind a question before final narration', async () => {
    const { voice } = fixture(vi.fn(async () => initialIvySnapshot()));
    const speech = TestBed.inject(SpeechAdapterService);
    const state = speech.state as WritableSignal<
      ReturnType<typeof initialSpeechSnapshot>
    >;
    const speak = vi.fn(async (_text: string, operation_id: string) => {
      const snapshot = {
        ...state(),
        operation_id,
        revision: String(BigInt(state().revision) + 1n),
        state: 'speaking' as const,
      };
      state.set(snapshot);
      return snapshot;
    });
    Object.assign(speech, { speak });
    await voice.refreshSession();
    TestBed.tick();
    const conversation = Reflect.get(voice, 'conversation') as {
      say: (
        text: string,
        id: string,
        current?: () => boolean,
      ) => Promise<unknown>;
    };
    voice.notifyQuestion('q1');
    for (let i = 0; i < 12; i++) await Promise.resolve();
    let owned = true;
    const queued = conversation.say(
      'A superseded response segment.',
      '11111111-2222-4333-8444-555555555555',
      () => owned,
    );
    const cancelled = expect(queued).rejects.toThrow('expired');
    owned = false;
    state.set({ ...state(), revision: '2', state: 'idle' });
    TestBed.tick();
    await cancelled;
    const final = conversation.say(
      'Your first event is at ten.',
      '22222222-2222-4333-8444-555555555555',
    );
    for (let i = 0; i < 12; i++) await Promise.resolve();
    state.set({ ...state(), revision: '4', state: 'idle' });
    TestBed.tick();
    await final;
    expect(speak.mock.calls.map((call) => call[0])).toEqual([
      'Could you check this out?',
      'Your first event is at ten.',
    ]);
    TestBed.resetTestingModule();
  });

  it.each(['mute', 'stop', 'dispose'])(
    'does not dispatch queued narration after %s while a question is playing',
    async (operation) => {
      const { voice } = fixture(vi.fn(async () => initialIvySnapshot()));
      const speech = TestBed.inject(SpeechAdapterService);
      const state = speech.state as WritableSignal<
        ReturnType<typeof initialSpeechSnapshot>
      >;
      const speak = vi.fn(async (_text: string, operation_id: string) => {
        const snapshot = {
          ...state(),
          operation_id,
          revision: '1',
          state: 'speaking' as const,
        };
        state.set(snapshot);
        return snapshot;
      });
      Object.assign(speech, { speak });
      await voice.refreshSession();
      TestBed.tick();
      voice.notifyQuestion('q1');
      const conversation = Reflect.get(voice, 'conversation') as {
        say: (text: string, id: string) => Promise<unknown>;
      };
      const pending = conversation.say(
        'Final narration',
        '11111111-2222-4333-8444-555555555555',
      );
      const cancelled = expect(pending).rejects.toThrow('cancelled');
      if (operation === 'mute') voice.setMuted(true);
      else if (operation === 'stop') voice.stop();
      else TestBed.resetTestingModule();
      await cancelled;
      expect(speak).toHaveBeenCalledExactlyOnceWith(
        'Could you check this out?',
        expect.any(String),
      );
      TestBed.resetTestingModule();
    },
  );
  it('starts continuous microphone capture only after local speech initialization succeeds', async () => {
    const { voice } = fixture(vi.fn(async () => initialIvySnapshot()));
    const speech = TestBed.inject(SpeechAdapterService);
    const experience = TestBed.inject(DesktopExperience);
    await voice.startListening();
    expect(speech.initialize).toHaveBeenCalledOnce();
    expect(experience.startListening).toHaveBeenCalledOnce();
    vi.mocked(speech.initialize).mockRejectedValueOnce(Error('Unavailable'));
    await voice.startListening();
    expect(experience.startListening).toHaveBeenCalledOnce();
    TestBed.resetTestingModule();
  });
  it('loads a persisted model without overwriting a draft edited while the snapshot is pending', async () => {
    let resolve!: (value: ReturnType<typeof initialIvySnapshot>) => void;
    const snapshot = vi.fn(
      () =>
        new Promise<ReturnType<typeof initialIvySnapshot>>((done) => {
          resolve = done;
        }),
    );
    const { voice } = fixture(snapshot);
    voice.setDraft('keep this draft');
    resolve({ ...initialIvySnapshot(), model: 'sol' });
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(voice.composition().raw).toBe('keep this draft');
    expect(voice.composition().model).toBe('sol');
    TestBed.resetTestingModule();
  });

  it('restores persisted Sol and clears the foreground only after a confirmed reset', async () => {
    const { voice, ivy } = fixture(
      vi.fn(async () => ({ ...initialIvySnapshot(), model: 'sol' })),
    );
    await vi.waitFor(() => expect(voice.composition().model).toBe('sol'));
    const clear = vi.fn();
    voice.bindForegroundClear(clear);
    voice.setDraft('unsent');
    ivy.clearConversation.mockResolvedValueOnce(false);
    expect(await voice.resetConversation()).toBe(false);
    expect(voice.composition().raw).toBe('unsent');
    expect(clear).not.toHaveBeenCalled();
    expect(await voice.resetConversation()).toBe(true);
    expect(clear).toHaveBeenCalledOnce();
    expect(voice.composition().raw).toBe('');
    expect(voice.composition().model).toBe('terra');
    TestBed.resetTestingModule();
  });

  it('refuses an unsettled or failed fresh snapshot during explicit refresh', async () => {
    const snapshot = vi.fn(async () => initialIvySnapshot());
    const { voice } = fixture(snapshot);
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledOnce());
    voice.setDraft('retained');
    snapshot.mockResolvedValueOnce({
      ...initialIvySnapshot(),
      turn: 'uncertain',
    });
    expect(await voice.refreshSession()).toBe(false);
    snapshot.mockRejectedValueOnce(new Error('busy'));
    expect(await voice.refreshSession()).toBe(false);
    expect(voice.composition().raw).toBe('retained');
    TestBed.resetTestingModule();
  });

  it('keeps voice unavailable after a failed startup snapshot until a successful refresh', async () => {
    const snapshot = vi
      .fn()
      .mockRejectedValueOnce(new Error('busy'))
      .mockResolvedValue(initialIvySnapshot());
    const { voice } = fixture(snapshot);
    await vi.waitFor(() => expect(voice.state().error).toBe(true));
    expect(await voice.refreshSession()).toBe(true);
    expect(voice.state().error).toBe(false);
    expect(voice.composition()).toMatchObject({
      raw: '',
      status: 'idle',
      error: '',
    });
    TestBed.resetTestingModule();
  });
});
import type {
  AudioActivityState,
  PcmEvent,
} from '@stellar/service-audio-activity';

describe('desktop voice cleanup integration', () => {
  async function setup(transcript: string, refine: ReturnType<typeof vi.fn>) {
    let receive!: (event: PcmEvent) => void;
    const audio = signal<AudioActivityState>({
      status: 'capturing',
      activity: {
        calibrating: false,
        active: false,
        level: 0.1,
        peakLevel: 0.1,
        durationMs: 0,
        noiseFloor: 0.001,
        clipped: false,
      },
    });
    const assistant = {
      state: signal({ ...initialIvySnapshot(), connection: 'ready' as const }),
      submit: vi.fn(async (text: string, id: string) => {
        void text;
        void id;
        return true;
      }),
    };
    const speech = {
      keywordsAvailable: true,
      setDucking: vi.fn(),
      state: signal(initialSpeechSnapshot()),
      keywords: vi.fn(
        async (
          _pcm: Int16Array,
          _stream: string,
          sequence: number,
          _threshold: number,
          mode: string,
        ) => ({
          sequence,
          detection:
            mode === 'passive' ? { command: 'ivy', end_sample: 640 } : null,
        }),
      ),
      transcribe: vi.fn(async (_pcm: Int16Array, utterance_id: string) => ({
        version: 1,
        utterance_id,
        text: transcript,
      })),
      collect: vi.fn(async (_pcm: Int16Array, utterance_id: string) => ({
        version: 1,
        utterance_id,
        text: transcript,
      })),
      stop: vi.fn(async () => undefined),
    };
    const snapshot = vi.fn(async () => initialIvySnapshot());
    TestBed.configureTestingModule({
      providers: [
        DesktopVoice,
        {
          provide: IvyAdapterService,
          useValue: { snapshot, selectSession: vi.fn(async () => true) },
        },
        { provide: PromptCleanupService, useValue: { refine } },
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
          provide: DesktopExperience,
          useValue: {
            state: signal({ phase: 'idle' }),
            setPassiveListening: vi.fn(),
            setVoiceCapturePaused: vi.fn(),
            waitForVoiceCaptureRelease: vi.fn(async () => undefined),
          },
        },
      ],
    });
    const voice = TestBed.inject(DesktopVoice);
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledOnce());
    await Promise.resolve();
    TestBed.tick();
    let sequence = 0;
    receive({
      type: 'chunk',
      chunk: {
        sampleRate: 16000,
        sequence: sequence++,
        samples: new Int16Array(640).fill(2000),
      },
    });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    const utterance = () => {
      for (const [active, count] of [
        [true, 5],
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
    };
    return { voice, assistant, utterance, receive };
  }

  it('calls the actual cleanup port once for end prompt and submits its result once with raw retained', async () => {
    const refine = vi.fn(async (raw: string) => ({
      raw,
      text: 'Refined ALPHA-42',
      status: 'refined',
    }));
    const f = await setup('end prompt', refine);
    f.voice.setDraft(' Um ALPHA-42 ');
    f.utterance();
    await vi.waitFor(() => expect(f.assistant.submit).toHaveBeenCalledOnce());
    expect(refine).toHaveBeenCalledOnce();
    expect(refine.mock.calls[0][0]).toBe(' Um ALPHA-42 ');
    expect(f.assistant.submit.mock.calls[0][0]).toBe('Refined ALPHA-42');
    expect(f.voice.composition().lastSubmittedRaw).toBe(' Um ALPHA-42 ');
    TestBed.resetTestingModule();
  });

  it('exposes the presentation handoff and submits only after its completion', async () => {
    const refine = vi.fn(async (raw: string) => ({
      raw,
      text: 'Refined prompt',
      status: 'refined',
    }));
    let complete!: () => void;
    const present = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    const f = await setup('end prompt', refine);
    const unbind = f.voice.bindPromptPresentation(present);
    f.voice.setDraft('raw prompt');
    f.utterance();
    await vi.waitFor(() => expect(present).toHaveBeenCalledOnce());
    expect(f.voice.composition()).toMatchObject({
      raw: 'raw prompt',
      refined: 'Refined prompt',
      status: 'finalizing',
    });
    expect(f.assistant.submit).not.toHaveBeenCalled();
    complete();
    await vi.waitFor(() => expect(f.assistant.submit).toHaveBeenCalledOnce());
    expect(f.assistant.submit.mock.calls[0][0]).toBe('Refined prompt');
    unbind();
    TestBed.resetTestingModule();
  });

  it('submits the raw fallback once when cleanup is unavailable', async () => {
    const refine = vi.fn(async (raw: string) => ({
      raw,
      text: raw,
      status: 'fallback',
    }));
    const f = await setup('end prompt', refine);
    f.voice.setDraft(' Keep ALPHA-42 ');
    f.utterance();
    await vi.waitFor(() => expect(f.assistant.submit).toHaveBeenCalledOnce());
    expect(refine).toHaveBeenCalledOnce();
    expect(f.assistant.submit.mock.calls[0][0]).toBe(' Keep ALPHA-42 ');
    TestBed.resetTestingModule();
  });

  it('does not call cleanup for an ordinary speech turn', async () => {
    const refine = vi.fn();
    const f = await setup('Ivy, ordinary request', refine);
    f.utterance();
    await vi.waitFor(() => expect(f.assistant.submit).toHaveBeenCalledOnce());
    expect(refine).not.toHaveBeenCalled();
    TestBed.resetTestingModule();
  });

  it('aborts actual cleanup on capture reset and never submits a late result', async () => {
    let resolve!: (value: {
      raw: string;
      text: string;
      status: string;
    }) => void;
    const refine = vi.fn((raw: string, signal: AbortSignal) => {
      void raw;
      void signal;
      return new Promise<{ raw: string; text: string; status: string }>(
        (done) => {
          resolve = done;
        },
      );
    });
    const f = await setup('end prompt', refine);
    f.voice.setDraft('raw prompt');
    f.utterance();
    await vi.waitFor(() => expect(refine).toHaveBeenCalledOnce());
    const abort = refine.mock.calls[0][1] as AbortSignal;
    f.receive({ type: 'reset' });
    expect(abort.aborted).toBe(true);
    resolve({ raw: 'raw prompt', text: 'late output', status: 'refined' });
    await Promise.resolve();
    await Promise.resolve();
    expect(f.assistant.submit).not.toHaveBeenCalled();
    expect(f.voice.composition().raw).toBe('raw prompt');
    TestBed.resetTestingModule();
  });
});
