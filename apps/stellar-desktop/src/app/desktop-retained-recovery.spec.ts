import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  AudioActivityService,
  type PcmEvent,
} from '@stellar/service-audio-activity';
import {
  IvyAdapterService,
  IVY_TRANSPORT,
  IvyReflexService,
  SpeechAdapterService,
  SPEECH_TRANSPORT,
  PromptCleanupService,
  initialIvySnapshot,
  initialSpeechSnapshot,
} from '@stellar/service-desktop-adapter';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesktopAssistant } from './desktop-assistant';
import { DesktopExperience } from './desktop-experience';
import { DesktopVoice } from './desktop-voice';

async function reconnect(refused = false) {
  let receive!: (event: PcmEvent) => void;
  const audio = signal({
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
  let native = {
    ...initialIvySnapshot(),
    revision: '1',
    connection: 'ready' as const,
    model: 'sol' as const,
  };
  const invoke = vi.fn(
    async (command: string, args?: { request?: unknown }) => {
      if (command === 'ivy_snapshot' || command === 'ivy_connect')
        return native;
      if (command === 'ivy_load_retained') {
        expect(args?.request).toEqual({
          version: 1,
          session_id: 'retained-session',
        });
        if (refused) throw 'approval_required';
        native = {
          ...native,
          revision: '2',
          verified_model: 'sol',
          turn_id: null,
        };
        return native;
      }
      throw Error('Unexpected fixture command');
    },
  );
  const speechInvoke = vi.fn(async (command: string) => {
    if (command === 'speech_keywords') throw 'unavailable';
    if (command === 'speech_snapshot' || command === 'speech_stop')
      return initialSpeechSnapshot();
    if (command === 'speech_set_ducking') return undefined;
    throw Error('Unexpected fixture speech operation');
  });
  TestBed.configureTestingModule({
    providers: [
      DesktopVoice,
      DesktopAssistant,
      IvyAdapterService,
      SpeechAdapterService,
      {
        provide: IVY_TRANSPORT,
        useValue: { invoke, listen: async () => () => undefined },
      },
      {
        provide: SPEECH_TRANSPORT,
        useValue: {
          keywordsAvailable: true,
          invoke: speechInvoke,
          listen: async () => () => undefined,
        },
      },
      {
        provide: AudioActivityService,
        useValue: {
          state: audio,
          subscribePcm: (callback: typeof receive) => {
            receive = callback;
            return () => undefined;
          },
        },
      },
      { provide: PromptCleanupService, useValue: {} },
      {
        provide: IvyReflexService,
        useValue: {
          localAvailable: () => false,
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
  await vi.waitFor(() => expect(voice.composition().model).toBe('sol'));
  TestBed.tick();
  receive({
    type: 'chunk',
    chunk: {
      sampleRate: 16000,
      sequence: 0,
      samples: new Int16Array(640).fill(2000),
    },
  });
  await vi.waitFor(() =>
    expect(voice.state().status).toBe(
      'Local command recognition unavailable. Retry voice or use text.',
    ),
  );
  TestBed.tick();
  return { voice, invoke, speechInvoke };
}

describe('cold retained recovery through Desktop adapters', () => {
  afterEach(() => TestBed.resetTestingModule());
  it('loads the retained identity once with unavailable keyword recognition and retains the voice failure', async () => {
    const f = await reconnect();
    expect(await f.voice.loadRetained('retained-session')).toBe(true);
    expect(
      f.invoke.mock.calls.filter((c) => c[0] === 'ivy_load_retained'),
    ).toHaveLength(1);
    expect(
      f.invoke.mock.calls.some((c) =>
        [
          'ivy_submit',
          'ivy_new_session',
          'ivy_select_session',
          'ivy_reconcile',
        ].includes(c[0]),
      ),
    ).toBe(false);
    expect(f.voice.state().error).toBe(true);
    expect(f.voice.composition().model).toBe('sol');
    expect(
      f.speechInvoke.mock.calls.filter((c) => c[0] === 'speech_keywords'),
    ).toHaveLength(1);
  });
  it('preserves a genuine native approval refusal with its load stage and never retries', async () => {
    const f = await reconnect(true);
    await expect(
      f.voice.loadRetained('retained-session'),
    ).rejects.toMatchObject({
      stage: 'native_load',
      code: 'approval_required',
    });
    expect(
      f.invoke.mock.calls.filter((c) => c[0] === 'ivy_load_retained'),
    ).toHaveLength(1);
    expect(
      f.invoke.mock.calls.some(
        (c) => c[0] === 'ivy_reconcile' || c[0] === 'ivy_question_reply',
      ),
    ).toBe(false);
  });
});
