import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AudioActivityService } from '@stellar/service-audio-activity';
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

const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  TestBed.tick();
};
async function fixture() {
  let admission!: (accepted: boolean) => void;
  const assistant = {
    state: signal({ ...initialIvySnapshot(), connection: 'ready' as const }),
    submit: vi.fn(
      (_text: string, _id: string) =>
        new Promise<boolean>((resolve) => {
          admission = resolve;
        }),
    ),
  };
  const speech = {
    state: signal(initialSpeechSnapshot()),
    setDucking: vi.fn(),
    stop: vi.fn(async () => {
      speech.state.update((state) => ({
        ...state,
        epoch: String(BigInt(state.epoch) + 1n),
        revision: String(BigInt(state.revision) + 1n),
        state: 'idle',
      }));
    }),
    speak: vi.fn(async (_text: string, operation_id: string) => {
      expect(speech.state().state).toBe('idle');
      const snapshot = {
        ...speech.state(),
        operation_id,
        revision: String(BigInt(speech.state().revision) + 1n),
        state: 'speaking' as const,
      };
      speech.state.set(snapshot);
      return snapshot;
    }),
  };
  TestBed.configureTestingModule({
    providers: [
      DesktopVoice,
      { provide: DesktopAssistant, useValue: assistant },
      { provide: SpeechAdapterService, useValue: speech },
      {
        provide: IvyAdapterService,
        useValue: { snapshot: async () => initialIvySnapshot() },
      },
      { provide: PromptCleanupService, useValue: {} },
      {
        provide: AudioActivityService,
        useValue: {
          state: signal({ status: 'idle' }),
          subscribePcm: () => () => undefined,
        },
      },
      {
        provide: DesktopExperience,
        useValue: {
          state: signal({ phase: 'idle' }),
          setPassiveListening: vi.fn(),
        },
      },
      {
        provide: IvyReflexService,
        useValue: {
          localAvailable: () => false,
          run: async () => ({ handled: false }),
          reply: signal(''),
          cancel: vi.fn(),
          timeline: { speech: vi.fn(), finish: vi.fn() },
        },
      },
    ],
  });
  const voice = TestBed.inject(DesktopVoice);
  await voice.refreshSession();
  TestBed.tick();
  const finishSpeech = async () => {
    speech.state.update((state) => ({
      ...state,
      revision: String(BigInt(state.revision) + 1n),
      state: 'idle',
    }));
    TestBed.tick();
    await settle();
  };
  return {
    voice,
    assistant,
    speech,
    finishSpeech,
    admission: (accepted: boolean) => admission(accepted),
  };
}
describe('locally owned typed response narration', () => {
  afterEach(() => TestBed.resetTestingModule());
  it('arms before submit, speaks interims before completion, and reconciles final/event repeats once', async () => {
    const f = await fixture();
    const submitting = f.voice.submitText('Check my calendar and the news');
    await settle();
    const turn = f.assistant.submit.mock.calls[0][1];
    const first = {
      id: '1'.repeat(64),
      kind: 'commentary' as const,
      sequence: '1',
      text: 'Morning! I am checking your day.',
      reused: false,
    };
    const second = {
      ...first,
      id: '2'.repeat(64),
      sequence: '2',
      text: 'Your meeting is at ten.',
    };
    f.assistant.state.update((state) => ({
      ...state,
      turn_id: turn,
      turn: 'admitted',
      response_segments: [first],
    }));
    TestBed.tick();
    await settle();
    expect(f.speech.speak.mock.calls.map((call) => call[0])).toEqual([
      first.text,
    ]);
    expect(f.assistant.state().turn).toBe('admitted');
    f.assistant.state.update((state) => ({
      ...state,
      response_segments: [first, second],
    }));
    TestBed.tick();
    expect(f.speech.speak).toHaveBeenCalledOnce();
    await f.finishSpeech();
    expect(f.speech.speak.mock.calls.map((call) => call[0])).toEqual([
      first.text,
      second.text,
    ]);
    f.assistant.state.update((state) => ({
      ...state,
      turn: 'completed',
      items: [{ kind: 'text', text: second.text }],
      response_segments: [
        first,
        second,
        {
          ...second,
          id: '3'.repeat(64),
          kind: 'final',
          sequence: null,
          reused: true,
        },
      ],
    }));
    TestBed.tick();
    // A late transport refusal cannot undo observed canonical admission/completion.
    f.admission(false);
    expect(await submitting).toBe(true);
    await f.finishSpeech();
    TestBed.tick();
    expect(f.speech.speak).toHaveBeenCalledTimes(2);
    expect(f.voice.state().foregroundActive).toBe(true);
  });

  it.each([false, true])(
    'does not narrate restored history and honors mute=%s on a new local turn',
    async (muted) => {
      const f = await fixture();
      f.assistant.state.update((state) => ({
        ...state,
        turn: 'completed',
        turn_id: '11111111-2222-4333-8444-555555555555',
        items: [{ kind: 'text', text: 'Old reply' }],
      }));
      TestBed.tick();
      await settle();
      expect(f.speech.speak).not.toHaveBeenCalled();
      f.voice.setMuted(muted);
      const submitting = f.voice.submitText('A new question');
      await settle();
      const turn = f.assistant.submit.mock.calls[0][1];
      f.assistant.state.update((state) => ({
        ...state,
        turn_id: turn,
        turn: 'completed',
        items: [{ kind: 'text', text: 'A new reply' }],
      }));
      TestBed.tick();
      f.admission(true);
      expect(await submitting).toBe(true);
      await settle();
      expect(f.speech.speak).toHaveBeenCalledTimes(muted ? 0 : 1);
      if (!muted) await f.finishSpeech();
      f.voice.setMuted(false);
      TestBed.tick();
      expect(f.speech.speak).toHaveBeenCalledTimes(muted ? 0 : 1);
    },
  );
});
