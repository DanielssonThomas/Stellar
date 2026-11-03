import { describe, expect, it, vi } from 'vitest';
import type {
  SpeechTranscript,
  SpeechSnapshot,
  KeywordCommand,
  KeywordReply,
} from '@stellar/desktop-contracts';
import { initialIvySnapshot } from '../ivy/ivy-transport';
import { initialSpeechSnapshot } from './speech-transport';
import {
  VoiceConversation,
  type VoiceContext,
  type VoiceView,
  type VoicePorts,
} from './voice-conversation';
import { voiceCommand, type VoiceComposition } from './voice-composition';
import { createNativePromptCleanup } from './native-prompt-cleanup';

const id = '11111111-2222-4333-8444-555555555555';

describe('dedicated command recognition integration', () => {
  it('routes quiet speech through fallback even when visual activity stays below its threshold', async () => {
    const f = fixture({
      keywords: async (_pcm, _stream, sequence) => ({
        sequence,
        detection: null,
      }),
    });
    await f.controller.withCaptureReleased(async () => true);
    for (let sequence = 0; sequence < 45; sequence++)
      f.controller.accept({
        type: 'chunk',
        chunk: {
          sampleRate: 16000,
          sequence,
          samples: new Int16Array(640).fill(sequence < 8 ? 180 : 0),
        },
      });
    await settle();
    expect(f.ports.transcribe).toHaveBeenCalledOnce();
    expect(f.ports.submit).toHaveBeenCalledOnce();
    f.controller.dispose();
  });
  it('allows exact final prompt-cancel fallback without submitting or refining the draft', async () => {
    const collect = vi.fn(async (_pcm: Int16Array, utterance_id: string) => ({
      version: 1,
      utterance_id,
      text: 'Prompt cancel.',
    }));
    const refine = vi.fn(async (raw: string) => raw);
    const f = fixture({
      keywords: async (_pcm, _stream, sequence) => ({
        sequence,
        detection: null,
      }),
      collect,
      refinePrompt: refine,
    });
    f.controller.setDraft('Retain until explicitly cancelled');
    f.utterance();
    await settle();
    expect(f.composition()).toMatchObject({ raw: '', status: 'idle' });
    expect(f.view().passive).toBe(true);
    expect(refine).not.toHaveBeenCalled();
    expect(f.ports.submit).not.toHaveBeenCalled();
    f.controller.dispose();
  });
  it('rejects a delayed acoustic prefix if later captured audio already resumed', async () => {
    const result = deferred<KeywordReply>();
    const cleared = vi.fn(async () => true);
    const f = fixture({
      keywords: async (_pcm, _stream, sequence) =>
        sequence === 10 ? result.promise : { sequence, detection: null },
      clearConversation: cleared,
    });
    await f.controller.withCaptureReleased(async () => true);
    f.feed(true, 5);
    f.feed(false, 6);
    await settle();
    f.feed(true, 10);
    f.feed(false, 30);
    result.resolve({
      sequence: 10,
      detection: { command: 'clear', end_sample: 3200 },
    });
    await settle();
    expect(cleared).not.toHaveBeenCalled();
    f.controller.dispose();
  });
  it('fences a delayed second candidate when a continued phrase reaches the quiet boundary', async () => {
    const second = deferred<KeywordReply>();
    const cleared = vi.fn(async () => true);
    const f = fixture({
      keywords: async (_pcm, _stream, sequence) =>
        sequence === 26
          ? second.promise
          : {
              sequence,
              detection:
                sequence === 10 ? { command: 'clear', end_sample: 3200 } : null,
            },
      clearConversation: cleared,
    });
    await f.controller.withCaptureReleased(async () => true);
    f.feed(true, 5);
    f.feed(false, 6);
    await settle();
    f.feed(true, 10);
    f.feed(false, 6);
    await settle();
    f.feed(false, 19);
    second.resolve({
      sequence: 26,
      detection: { command: 'clear', end_sample: 6400 },
    });
    await settle();
    expect(cleared).not.toHaveBeenCalled();
    expect(f.ports.transcribe).not.toHaveBeenCalled();
    f.feed(false, 15);
    await settle();
    expect(cleared).not.toHaveBeenCalled();
    expect(f.ports.transcribe).toHaveBeenCalledOnce();
    expect(f.ports.submit).toHaveBeenCalledOnce();
    f.controller.dispose();
  });
  async function provisionalControl() {
    const cleared = vi.fn(async () => true);
    const f = fixture({
      keywords: async (_pcm, _stream, sequence) => ({
        sequence,
        detection:
          sequence === 10 ? { command: 'clear', end_sample: 3200 } : null,
      }),
      clearConversation: cleared,
    });
    await f.controller.withCaptureReleased(async () => true);
    f.feed(true, 5);
    f.feed(false, 6);
    await settle();
    expect(cleared).not.toHaveBeenCalled();
    return { ...f, cleared };
  }
  it('defers a standalone acoustic control until the action boundary', async () => {
    const f = await provisionalControl();
    f.feed(false, 19);
    await settle();
    expect(f.cleared).toHaveBeenCalledOnce();
    expect(f.ports.transcribe).not.toHaveBeenCalled();
    f.controller.dispose();
  });
  it('cancels a command prefix when speech continues after a thinking pause', async () => {
    const f = await provisionalControl();
    f.feed(false, 5);
    f.feed(true, 10);
    f.feed(false, 40);
    await settle();
    expect(f.cleared).not.toHaveBeenCalled();
    expect(f.ports.transcribe).toHaveBeenCalledOnce();
    f.controller.dispose();
  });
  it.each(['gap', 'malformed'] as const)(
    'fails closed on %s at the exact control boundary',
    async (kind) => {
      const f = await provisionalControl();
      f.feed(false, 18);
      await settle();
      f.controller.accept({
        type: 'chunk',
        chunk: {
          sampleRate: 16000,
          sequence: kind === 'gap' ? 30 : 29,
          samples: new Int16Array(kind === 'malformed' ? 641 : 640),
        },
      });
      await settle();
      expect(f.cleared).not.toHaveBeenCalled();
      expect(f.view().error).toBe(true);
      f.controller.dispose();
    },
  );
  it('fences a provisional control when public Clear completes between PCM events', async () => {
    const f = await provisionalControl();
    await f.controller.resetConversation();
    expect(f.cleared).toHaveBeenCalledOnce();
    f.feed(false, 30);
    await settle();
    expect(f.cleared).toHaveBeenCalledOnce();
    f.controller.dispose();
  });
  it('keeps warm recognizers through a capture continuity reset and reaps them on explicit stop', async () => {
    const f = fixture({
      keywords: async (_pcm, _stream, sequence) => ({
        sequence,
        detection: { command: 'ivy', end_sample: 640 },
      }),
    });
    f.feed(true, 1);
    await settle();
    f.controller.accept({ type: 'reset' });
    await settle();
    expect(f.ports.stop).not.toHaveBeenCalled();
    f.controller.stopVoice();
    await settle();
    expect(f.ports.stop).toHaveBeenCalledOnce();
    f.controller.dispose();
  });
  const settle = async () => {
    for (let i = 0; i < 160; i++) await Promise.resolve();
  };
  it('does not transcribe passive speech and retains an immediate request while wake inference is pending', async () => {
    const wake = deferred<KeywordReply>();
    const f = fixture({ keywords: () => wake.promise });
    f.feed(true, 8);
    f.feed(false, 40);
    expect(f.ports.transcribe).not.toHaveBeenCalled();
    expect(f.ports.submit).not.toHaveBeenCalled();
    wake.resolve({
      sequence: 0,
      detection: { command: 'ivy', end_sample: 640 },
    });
    await settle();
    expect(f.ports.transcribe).toHaveBeenCalledOnce();
    expect(f.ports.submit).toHaveBeenCalledExactlyOnceWith(
      'A spoken request',
      id,
    );
    f.controller.dispose();
  });
  it.each([
    'done',
    'clear',
    'prompt',
    'new session',
    'reload mcp',
  ] as KeywordCommand[])(
    'routes acoustic %s through the existing command semantics without STT',
    async (control) => {
      let command: KeywordCommand | null = 'ivy';
      const cleared = vi.fn(async () => true),
        reset = vi.fn(async () => true),
        reload = vi.fn(async () => true);
      const f = fixture({
        keywords: async (_pcm, _stream, sequence) => ({
          sequence,
          detection: command ? { command, end_sample: 640 } : null,
        }),
        clearConversation: cleared,
        newSession: reset,
        reloadMcp: reload,
      });
      f.feed(true, 1);
      await settle();
      command = control;
      f.feed(true, 1);
      f.feed(false, 25);
      await settle();
      expect(f.ports.transcribe).not.toHaveBeenCalled();
      expect(f.ports.submit).not.toHaveBeenCalled();
      if (control === 'clear' || control === 'done')
        expect(cleared).toHaveBeenCalledOnce();
      if (control === 'new session') expect(reset).toHaveBeenCalledOnce();
      if (control === 'reload mcp') expect(reload).toHaveBeenCalledOnce();
      if (control === 'prompt')
        expect(f.composition()).toMatchObject({
          model: 'sol',
          status: 'composing',
        });
      f.controller.dispose();
    },
  );
  it('cancels composition without cleanup, transcription, or submission and requires a fresh wake', async () => {
    const refine = vi.fn(async (raw: string) => raw);
    const f = fixture({
      keywords: async (_pcm, _stream, sequence) => ({
        sequence,
        detection: { command: 'prompt cancel', end_sample: 640 },
      }),
      refinePrompt: refine,
    });
    f.controller.setDraft('Keep this only until cancelled');
    f.feed(true, 1);
    f.feed(false, 25);
    await settle();
    expect(f.composition()).toMatchObject({
      raw: '',
      refined: null,
      status: 'idle',
    });
    expect(f.view().passive).toBe(true);
    expect(refine).not.toHaveBeenCalled();
    expect(f.ports.transcribe).not.toHaveBeenCalled();
    expect(f.ports.submit).not.toHaveBeenCalled();
    f.controller.dispose();
  });
  it('retains the awake state and draft when acoustic clear is refused', async () => {
    const f = fixture({
      keywords: async (_pcm, _stream, sequence) => ({
        sequence,
        detection: { command: 'clear', end_sample: 640 },
      }),
      clearConversation: async () => false,
      readSession: async () => 'sol',
    });
    f.controller.setDraft('Retain this draft');
    f.feed(true, 1);
    f.feed(false, 25);
    await settle();
    expect(f.view().passive).toBe(false);
    expect(f.composition().raw).toBe('Retain this draft');
    expect(f.ports.submit).not.toHaveBeenCalled();
    f.controller.dispose();
  });
  it('fences a pending wake at an authoritative session reset', async () => {
    const pending = deferred<KeywordReply>();
    const f = fixture({ keywords: () => pending.promise });
    f.feed(true, 1);
    f.update({
      assistant: { ...f.context().assistant, reset_id: 'new-session-fence' },
    });
    pending.resolve({
      sequence: 0,
      detection: { command: 'ivy', end_sample: 640 },
    });
    await settle();
    expect(f.view().passive).toBe(true);
    expect(f.ports.submit).not.toHaveBeenCalled();
    expect(f.ports.stop).toHaveBeenCalledOnce();
    f.controller.dispose();
  });
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((done) => {
      resolve = done;
    }),
    resolve,
  };
}
async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

function fixture(extra: Partial<VoicePorts> = {}) {
  let context: VoiceContext = {
    available: true,
    audio: {
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
    },
    assistant: { ...initialIvySnapshot(), connection: 'ready' },
    speech: initialSpeechSnapshot(),
  };
  let view!: VoiceView;
  const ports = {
    transcribe: vi.fn(async (_pcm: Int16Array, utterance_id: string) => ({
      version: 1,
      utterance_id,
      text: 'A spoken request',
    })),
    submit: vi.fn(async () => true),
    speak: vi.fn(
      async (_text: string, operation_id: string): Promise<SpeechSnapshot> => ({
        ...initialSpeechSnapshot(),
        revision: '1',
        state: 'synthesizing' as const,
        operation_id,
      }),
    ),
    stop: vi.fn(async (): Promise<void> => undefined),
    id: vi.fn(() => id),
    onChange: (next: VoiceView) => {
      view = next;
    },
  };
  let composition!: VoiceComposition;
  const controller = new VoiceConversation({
    ...ports,
    ...extra,
    onComposition: (value) => {
      composition = value;
      extra.onComposition?.(value);
    },
  });
  controller.update(context);
  let sequence = 0;
  const update = (change: Partial<VoiceContext>) => {
    context = { ...context, ...change };
    controller.update(context);
  };
  const feed = (active: boolean, count: number, starting = false) => {
    update({
      audio: {
        ...context.audio,
        activity: { ...context.audio.activity, active, starting },
      },
    });
    for (let i = 0; i < count; i++) {
      const samples = new Int16Array(640).fill(active ? 2000 : 0);
      controller.accept({
        type: 'chunk',
        chunk: { sampleRate: 16000, sequence: sequence++, samples },
      });
      expect(samples.every((sample) => sample === 0)).toBe(true);
    }
  };
  const utterance = () => {
    feed(true, 5);
    feed(false, 35);
  };
  const freshStartingChunk = () => {
    const samples = new Int16Array(640).fill(2000);
    controller.accept(
      {
        type: 'chunk',
        chunk: { sampleRate: 16000, sequence: sequence++, samples },
      },
      {
        ...context.audio,
        activity: { ...context.audio.activity, starting: true },
      },
    );
    expect(samples.every((sample) => sample === 0)).toBe(true);
  };
  const completed = () =>
    update({
      assistant: {
        ...context.assistant,
        revision: '4',
        turn_id: id,
        turn: 'completed',
        items: [{ kind: 'text', text: 'A local reply' }],
      },
    });
  return {
    controller,
    composition: () => composition,
    ports,
    update,
    feed,
    utterance,
    freshStartingChunk,
    completed,
    context: () => context,
    view: () => view,
  };
}

describe('voice conversation ownership', () => {
  it.each([
    { label: 'empty reply', items: [], muted: false },
    {
      label: 'suppressed structured reply',
      items: [{ kind: 'text' as const, text: '{"stellar_presentation":' }],
      muted: false,
    },
    {
      label: 'oversized reply',
      items: [{ kind: 'text' as const, text: 'x'.repeat(4001) }],
      muted: false,
    },
    {
      label: 'muted reply',
      items: [{ kind: 'text' as const, text: 'A completed reply' }],
      muted: true,
    },
  ])(
    'finishes latency immediately for a completed $label without playback',
    async ({ items, muted }) => {
      performance.clearMeasures('stellar.voice.latency');
      const f = fixture();
      if (muted) f.controller.setMuted(true);
      f.utterance();
      await flush();
      expect(
        performance.getEntriesByName('stellar.voice.latency'),
      ).toHaveLength(0);
      f.update({
        assistant: {
          ...f.context().assistant,
          turn_id: id,
          turn: 'completed',
          items,
        },
      });
      const entries = performance.getEntriesByName(
        'stellar.voice.latency',
      ) as PerformanceMeasure[];
      expect(entries).toHaveLength(1);
      expect(entries[0].detail.outcome).toBe('completed');
      expect(entries[0].detail.stages_ms.model_completed).toBeDefined();
      expect(
        entries[0].detail.durations_ms.tts_to_first_audio_observed,
      ).toBeNull();
      expect(f.ports.speak).not.toHaveBeenCalled();
      f.controller.dispose();
      expect(
        performance.getEntriesByName('stellar.voice.latency'),
      ).toHaveLength(1);
      performance.clearMeasures('stellar.voice.latency');
    },
  );

  it.each(['failed', 'cancelled', 'uncertain'] as const)(
    'finishes latency immediately for a %s response',
    async (turn) => {
      performance.clearMeasures('stellar.voice.latency');
      const f = fixture();
      f.utterance();
      await flush();
      f.update({ assistant: { ...f.context().assistant, turn_id: id, turn } });
      const entries = performance.getEntriesByName(
        'stellar.voice.latency',
      ) as PerformanceMeasure[];
      expect(entries).toHaveLength(1);
      expect(entries[0].detail.outcome).toBe('interrupted');
      expect(entries[0].detail.durations_ms.validated_model_text).toBeNull();
      f.controller.dispose();
      expect(
        performance.getEntriesByName('stellar.voice.latency'),
      ).toHaveLength(1);
      performance.clearMeasures('stellar.voice.latency');
    },
  );

  it('finishes empty recognition and rejected admission latency without waiting for another turn', async () => {
    for (const empty of [true, false]) {
      performance.clearMeasures('stellar.voice.latency');
      const f = fixture({ submit: async () => false });
      if (empty)
        f.ports.transcribe.mockResolvedValueOnce({
          version: 1,
          utterance_id: id,
          text: '',
        });
      f.utterance();
      await flush();
      const entries = performance.getEntriesByName(
        'stellar.voice.latency',
      ) as PerformanceMeasure[];
      expect(entries).toHaveLength(1);
      expect(entries[0].detail.outcome).toBe(
        empty ? 'completed' : 'interrupted',
      );
      expect(entries[0].detail.durations_ms.validated_model_text).toBeNull();
      f.controller.dispose();
      expect(
        performance.getEntriesByName('stellar.voice.latency'),
      ).toHaveLength(1);
    }
    performance.clearMeasures('stellar.voice.latency');
  });

  it('does not charge idle time or the next request to a text-only reply latency', async () => {
    performance.clearMeasures('stellar.voice.latency');
    let now = 10;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const f = fixture();
    try {
      f.utterance();
      await flush();
      now = 100;
      f.update({
        assistant: {
          ...f.context().assistant,
          turn_id: id,
          turn: 'completed',
          items: [{ kind: 'text', text: 'x'.repeat(4001) }],
        },
      });
      const original = performance.getEntriesByName(
        'stellar.voice.latency',
      )[0] as PerformanceMeasure;
      expect(original.duration).toBe(90);
      expect(original.detail.outcome).toBe('completed');
      now = 60100;
      f.utterance();
      await flush();
      expect(
        performance.getEntriesByName('stellar.voice.latency'),
      ).toHaveLength(1);
      expect(original.duration).toBe(90);
      now = 60200;
      f.update({
        assistant: {
          ...f.context().assistant,
          turn_id: id,
          turn: 'completed',
          items: [],
        },
      });
      const entries = performance.getEntriesByName(
        'stellar.voice.latency',
      ) as PerformanceMeasure[];
      expect(entries).toHaveLength(2);
      expect(entries[1].duration).toBe(100);
    } finally {
      f.controller.dispose();
      clock.mockRestore();
      performance.clearMeasures('stellar.voice.latency');
    }
  });

  it('uses the current PCM-time onset snapshot even when the effect context is stale', async () => {
    let composition!: VoiceComposition;
    const collect = vi.fn(async (pcm: Int16Array, utterance_id: string) => ({
      version: 1,
      utterance_id,
      text: pcm.length < 20000 ? 'send' : 'send and continue',
    }));
    const f = fixture({
      collect,
      onComposition: (value) => {
        composition = value;
      },
    });
    f.controller.setDraft('seed');
    f.feed(true, 5);
    f.feed(false, 13);
    f.freshStartingChunk();
    f.freshStartingChunk();
    f.freshStartingChunk();
    expect(f.ports.submit).not.toHaveBeenCalled();
    f.feed(true, 8);
    f.feed(false, 35);
    for (let i = 0; i < 6; i++) await flush();
    expect(composition.raw).toBe('seed\nsend and continue');
    expect(f.ports.submit).not.toHaveBeenCalled();
  });
  it('does not classify a preview as send while the next onset is pending', async () => {
    let composition!: VoiceComposition;
    const collect = vi.fn(async (pcm: Int16Array, utterance_id: string) => ({
      version: 1,
      utterance_id,
      text: pcm.length < 20000 ? 'send' : 'send and continue',
    }));
    const f = fixture({
      collect,
      onComposition: (value) => {
        composition = value;
      },
    });
    f.controller.setDraft('seed');
    f.feed(true, 5);
    f.feed(false, 12);
    f.feed(false, 3, true);
    await flush();
    expect(f.ports.submit).not.toHaveBeenCalled();
    expect(composition.raw).toBe('seed');
    f.feed(true, 8);
    f.feed(false, 35);
    for (let i = 0; i < 6; i++) await flush();
    expect(composition.raw).toBe('seed\nsend and continue');
    expect(f.ports.submit).not.toHaveBeenCalled();
  });
  it('cancels a pending typed lease on an explicit conversation reset', async () => {
    const released = deferred<void>();
    const action = vi.fn(async () => true);
    const f = fixture({
      waitForCapturePause: () => released.promise,
      clearConversation: async () => true,
    });
    const pending = f.controller.withCaptureReleased(action);
    expect(await f.controller.resetConversation()).toBe(true);
    expect(await pending).toBe(false);
    released.resolve();
    await flush();
    expect(action).not.toHaveBeenCalled();
  });

  it('never sends after disposal interrupts a pending typed lease', async () => {
    const released = deferred<void>();
    const action = vi.fn(async () => true);
    const f = fixture({ waitForCapturePause: () => released.promise });
    const pending = f.controller.withCaptureReleased(action);
    f.controller.dispose();
    expect(await pending).toBe(false);
    released.resolve();
    await flush();
    expect(action).not.toHaveBeenCalled();
  });
  it('holds typed submission until physical capture release and transfers pause to the Ivy turn', async () => {
    const released = deferred<void>();
    const pause = vi.fn();
    const action = vi.fn(async () => true);
    const f = fixture({
      waitForCapturePause: () => released.promise,
      onCapturePauseChange: pause,
    });
    const pending = f.controller.withCaptureReleased(async () => {
      f.update({ assistant: { ...f.context().assistant, turn: 'admitted' } });
      return action();
    });
    expect(pause).toHaveBeenLastCalledWith(true);
    await flush();
    expect(action).not.toHaveBeenCalled();
    released.resolve();
    expect(await pending).toBe(true);
    expect(action).toHaveBeenCalledOnce();
    expect(pause).toHaveBeenLastCalledWith(true);
    f.update({ assistant: { ...f.context().assistant, turn: 'completed' } });
    expect(pause).toHaveBeenLastCalledWith(false);
  });

  it.each(['reset', 'unavailable'] as const)(
    'never submits a typed message after %s interrupts release',
    async (event) => {
      const released = deferred<void>();
      const action = vi.fn(async () => true);
      const f = fixture({ waitForCapturePause: () => released.promise });
      const pending = f.controller.withCaptureReleased(action);
      f.controller.accept({ type: event });
      expect(await pending).toBe(false);
      released.resolve();
      await flush();
      expect(action).not.toHaveBeenCalled();
    },
  );

  it('refuses typed submission when capture release fails or another lease is pending', async () => {
    const released = deferred<void>();
    const action = vi.fn(async () => true);
    const f = fixture({ waitForCapturePause: () => released.promise });
    const pending = f.controller.withCaptureReleased(action);
    expect(await f.controller.withCaptureReleased(action)).toBe(false);
    f.controller.stopVoice();
    expect(await pending).toBe(false);
    released.resolve();
    await flush();
    expect(action).not.toHaveBeenCalled();
    const failed = fixture({
      waitForCapturePause: async () => {
        throw new Error('release failed');
      },
    });
    expect(await failed.controller.withCaptureReleased(action)).toBe(false);
    expect(action).not.toHaveBeenCalled();
  });
  it('retains native cleanup serialization across reset and refines the new draft', async () => {
    const old = deferred<unknown>();
    const invoke = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce({ version: 1, text: 'new draft\nwords' });
    const cleanup = createNativePromptCleanup(invoke);
    const collect = vi.fn(async (_pcm: Int16Array, utterance_id: string) => ({
      version: 1,
      utterance_id,
      text: 'words',
    }));
    let composition!: VoiceComposition;
    const f = fixture({
      collect,
      refinePrompt: async (raw, signal) => (await cleanup(raw, signal)).text,
      onComposition: (value) => {
        composition = value;
      },
    });
    f.controller.setDraft('old draft');
    f.utterance();
    for (let i = 0; i < 6; i++) await flush();
    expect(invoke).toHaveBeenCalledTimes(1);
    f.controller.accept({ type: 'reset' });
    f.controller.setDraft('new draft');
    f.utterance();
    for (let i = 0; i < 6; i++) await flush();
    expect(composition.raw).toBe('new draft\nwords');
    expect(invoke).toHaveBeenCalledTimes(1);
    old.resolve({ version: 1, text: 'old draft\nwords' });
    for (let i = 0; i < 8; i++) await flush();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(composition.draft).toBe('new draft\nwords');
    expect(composition.refinementRevision).toBe(1);
  });
  it('pauses capture for an external Ivy admission and resumes with the draft intact', () => {
    const pause = vi.fn();
    let composition!: VoiceComposition;
    const f = fixture({
      onCapturePauseChange: pause,
      onComposition: (value) => {
        composition = value;
      },
    });
    f.controller.setDraft('retained draft');
    f.update({ assistant: { ...f.context().assistant, turn: 'submitting' } });
    expect(pause).toHaveBeenLastCalledWith(true);
    f.update({ assistant: { ...f.context().assistant, turn: 'admitted' } });
    expect(pause).toHaveBeenLastCalledWith(true);
    f.update({ assistant: { ...f.context().assistant, turn: 'completed' } });
    expect(pause).toHaveBeenLastCalledWith(false);
    expect(composition.raw).toBe('retained draft');
  });

  it('aborts active and queued draft cleanups on reset and fences their late results', async () => {
    let composition!: VoiceComposition;
    const first = deferred<string>();
    const collect = vi.fn(async (_pcm: Int16Array, utterance_id: string) => ({
      version: 1,
      utterance_id,
      text: 'words',
    }));
    const refinePrompt = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue('new cleaned');
    const f = fixture({
      collect,
      refinePrompt,
      onComposition: (value) => {
        composition = value;
      },
    });
    f.controller.setDraft('seed');
    f.utterance();
    for (let i = 0; i < 4; i++) await flush();
    f.utterance();
    for (let i = 0; i < 4; i++) await flush();
    const controllers = [
      ...(f.controller as unknown as { draftCleanups: Set<AbortController> })
        .draftCleanups,
    ];
    expect(controllers).toHaveLength(2);
    f.controller.accept({ type: 'reset' });
    expect(controllers.every((controller) => controller.signal.aborted)).toBe(
      true,
    );
    first.resolve('stale');
    for (let i = 0; i < 4; i++) await flush();
    expect(composition.draft).not.toBe('stale');
    expect(refinePrompt).toHaveBeenCalledTimes(1);
  });
  it('submits a previously cleaned full draft once after a standalone send', async () => {
    const collect = vi
      .fn()
      .mockResolvedValueOnce({ version: 1, utterance_id: id, text: 'sentence' })
      .mockResolvedValueOnce({
        version: 1,
        utterance_id: id,
        text: 'send prompt',
      });
    const refinePrompt = vi.fn(async () => 'clean draft');
    const f = fixture({ collect, refinePrompt });
    f.controller.setDraft('seed');
    f.utterance();
    for (let i = 0; i < 4; i++) await flush();
    expect(refinePrompt).toHaveBeenCalledTimes(1);
    f.utterance();
    for (let i = 0; i < 6; i++) await flush();
    expect(refinePrompt).toHaveBeenCalledTimes(1);
    expect(f.ports.submit).toHaveBeenCalledExactlyOnceWith('clean draft', id);
  });
  it('treats capped continuous speech as content until a real quiet boundary', async () => {
    let composition!: VoiceComposition;
    const collect = vi.fn(async (_pcm: Int16Array, utterance_id: string) => ({
      version: 1,
      utterance_id,
      text: 'send',
    }));
    const f = fixture({
      collect,
      onComposition: (value) => {
        composition = value;
      },
    });
    f.controller.setDraft('seed');
    f.feed(true, 505);
    f.feed(false, 14);
    for (let i = 0; i < 6; i++) await flush();
    expect(composition.raw).toBe('seed\nsend\nsend');
    expect(f.ports.submit).not.toHaveBeenCalled();
    f.utterance();
    for (let i = 0; i < 6; i++) await flush();
    expect(f.ports.submit).toHaveBeenCalledOnce();
  });
  it('shows a local partial without interpreting it as a send command', async () => {
    let composition!: VoiceComposition;
    const collect = vi.fn(async (_pcm: Int16Array, utterance_id: string) => ({
      version: 1,
      utterance_id,
      text: 'send prompt',
    }));
    const f = fixture({
      collect,
      onComposition: (value) => {
        composition = value;
      },
    });
    f.controller.setDraft('existing words');
    f.feed(true, 25);
    await flush();
    expect(composition.preview).toBe('send prompt');
    expect(composition.raw).toBe('existing words');
    expect(f.ports.submit).not.toHaveBeenCalled();
    expect(f.context().audio.status).toBe('capturing');
  });

  it('commits a complete utterance and refines the full draft while capture continues', async () => {
    let composition!: VoiceComposition;
    const collect = vi
      .fn()
      .mockResolvedValueOnce({ version: 1, utterance_id: id, text: 'new' })
      .mockResolvedValueOnce({
        version: 1,
        utterance_id: id,
        text: 'new words',
      });
    const refinePrompt = vi.fn(async (raw: string) =>
      raw.replace('old', 'Old'),
    );
    const f = fixture({
      collect,
      refinePrompt,
      onComposition: (value) => {
        composition = value;
      },
    });
    f.controller.setDraft('old');
    f.feed(true, 25);
    await flush();
    expect(composition.preview).toBe('new');
    f.feed(false, 35);
    await flush();
    await flush();
    expect(composition.raw).toBe('old\nnew words');
    expect(composition.draft).toBe('Old\nnew words');
    expect(composition.preview).toBe('');
    expect(composition.refinementRevision).toBe(1);
    expect(refinePrompt).toHaveBeenCalledExactlyOnceWith(
      'old\nnew words',
      expect.any(AbortSignal),
    );
    expect(f.context().audio.status).toBe('capturing');
    expect(f.ports.submit).not.toHaveBeenCalled();
  });

  it('keeps cleanup single-flight, ignores stale results, and refines the newest full draft', async () => {
    let composition!: VoiceComposition;
    const first = deferred<string>();
    const collect = vi
      .fn()
      .mockResolvedValueOnce({ version: 1, utterance_id: id, text: 'first' })
      .mockResolvedValueOnce({ version: 1, utterance_id: id, text: 'second' });
    const refinePrompt = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce('clean latest');
    const f = fixture({
      collect,
      refinePrompt,
      onComposition: (value) => {
        composition = value;
      },
    });
    f.controller.setDraft('seed');
    f.utterance();
    await flush();
    await flush();
    expect(refinePrompt).toHaveBeenCalledTimes(1);
    f.utterance();
    await flush();
    await flush();
    expect(composition.raw).toBe('seed\nfirst\nsecond');
    expect(refinePrompt).toHaveBeenCalledTimes(1);
    first.resolve('stale rewrite');
    await flush();
    await flush();
    expect(refinePrompt).toHaveBeenCalledTimes(2);
    expect(refinePrompt.mock.calls[1][0]).toBe('seed\nfirst\nsecond');
    expect(composition.draft).toBe('clean latest');
    expect(composition.refinementRevision).toBe(1);
  });

  it('dispatches ordinary speech after an idle session refresh', async () => {
    let composition!: VoiceComposition;
    const f = fixture({
      onComposition: (value) => {
        composition = value;
      },
    });
    expect(f.controller.reconcileSession('terra')).toBe(true);
    expect(composition).toMatchObject({ raw: '', status: 'idle', error: '' });
    f.utterance();
    await flush();
    expect(f.ports.submit).toHaveBeenCalledOnce();
    expect(f.ports.submit).toHaveBeenCalledWith('A spoken request', id);
  });

  it('preserves an empty explicit prompt and an over-limit draft on refresh', async () => {
    let composition!: VoiceComposition;
    const f = fixture({
      onComposition: (value) => {
        composition = value;
      },
    });
    f.ports.transcribe.mockResolvedValueOnce({
      version: 1,
      utterance_id: id,
      text: 'prompt',
    });
    f.utterance();
    await flush();
    expect(composition).toMatchObject({ raw: '', status: 'composing' });
    f.controller.reconcileSession('sol');
    expect(composition).toMatchObject({ raw: '', status: 'composing' });
    f.controller.setDraft('x'.repeat(8193));
    const error = composition.error;
    f.controller.reconcileSession('terra');
    expect(composition).toMatchObject({
      raw: 'x'.repeat(8193),
      status: 'error',
      error,
    });
    expect(f.ports.submit).not.toHaveBeenCalled();
  });
  it('resets the foreground only after confirmation and retains a refused draft', async () => {
    const clearConversation = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    let composition!: VoiceComposition;
    const f = fixture({
      clearConversation,
      onComposition: (value) => {
        composition = value;
      },
    });
    f.controller.setDraft('retain this');
    expect(await f.controller.resetConversation()).toBe(false);
    expect(composition.raw).toBe('retain this');
    expect(await f.controller.resetConversation()).toBe(true);
    expect(composition.raw).toBe('');
    expect(composition.model).toBe('terra');
  });
  it('does not infer on startup, calibration, quiet samples or empty recognition', async () => {
    const f = fixture();
    expect(f.ports.transcribe).not.toHaveBeenCalled();
    f.feed(false, 100);
    expect(f.ports.transcribe).not.toHaveBeenCalled();
    f.update({
      audio: {
        ...f.context().audio,
        activity: { ...f.context().audio.activity, calibrating: true },
      },
    });
    f.utterance();
    expect(f.ports.transcribe).not.toHaveBeenCalled();
    f.update({
      audio: {
        ...f.context().audio,
        activity: { ...f.context().audio.activity, calibrating: false },
      },
    });
    f.ports.transcribe.mockResolvedValueOnce({
      version: 1,
      utterance_id: id,
      text: '',
    });
    f.utterance();
    await flush();
    expect(f.ports.transcribe).toHaveBeenCalledOnce();
    expect(f.ports.submit).not.toHaveBeenCalled();
    expect(f.ports.speak).not.toHaveBeenCalled();
  });

  it('submits one stable utterance ID and speaks its canonical completion once', async () => {
    const f = fixture();
    f.utterance();
    await flush();
    expect(f.ports.submit).toHaveBeenCalledExactlyOnceWith(
      'A spoken request',
      id,
    );
    expect(
      f.ports.transcribe.mock.calls[0][0].every((sample) => sample === 0),
    ).toBe(true);
    f.completed();
    await flush();
    expect(f.ports.speak).toHaveBeenCalledExactlyOnceWith('A local reply', id);
    f.completed();
    f.utterance();
    expect(f.ports.transcribe).toHaveBeenCalledOnce();
    expect(f.ports.speak).toHaveBeenCalledOnce();
  });

  it('discards a late transcript after microphone stop and clears its samples', async () => {
    const pending = deferred<SpeechTranscript>();
    const f = fixture();
    f.ports.transcribe.mockReturnValueOnce(pending.promise);
    f.utterance();
    f.update({ audio: { ...f.context().audio, status: 'idle' } });
    pending.resolve({ version: 1, utterance_id: id, text: 'Must not send' });
    await flush();
    expect(f.ports.submit).not.toHaveBeenCalled();
    expect(f.ports.stop).toHaveBeenCalledOnce();
    expect(
      f.ports.transcribe.mock.calls[0][0].every((sample) => sample === 0),
    ).toBe(true);
  });

  it('keeps capture gated until stop settles and fails closed on stop rejection', async () => {
    const f = fixture();
    const stop = deferred<void>();
    f.ports.stop.mockReturnValueOnce(stop.promise);
    f.utterance();
    await flush();
    f.controller.stopVoice();
    f.utterance();
    expect(f.ports.transcribe).toHaveBeenCalledOnce();
    stop.resolve();
    await flush();
    f.feed(false, 1);
    f.utterance();
    await flush();
    expect(f.ports.transcribe).toHaveBeenCalledTimes(2);
    f.ports.stop.mockRejectedValueOnce(new Error('private failure'));
    f.controller.stopVoice();
    await flush();
    f.utterance();
    expect(f.ports.transcribe).toHaveBeenCalledTimes(2);
    expect(f.view().error).toBe(true);
    expect(f.view().status).not.toContain('private');
  });

  it('waits for playback acknowledgement and a new quiet period before collecting speaker tails', async () => {
    const f = fixture();
    const playback = deferred<ReturnType<typeof initialSpeechSnapshot>>();
    f.ports.speak.mockReturnValueOnce(playback.promise);
    f.utterance();
    await flush();
    f.completed();
    f.update({ speech: initialSpeechSnapshot() });
    f.utterance();
    expect(f.ports.transcribe).toHaveBeenCalledOnce();
    playback.resolve({
      ...initialSpeechSnapshot(),
      revision: '5',
      operation_id: id,
      state: 'speaking',
    });
    await flush();
    f.update({
      speech: { ...initialSpeechSnapshot(), revision: '6', operation_id: id },
    });
    f.feed(true, 10);
    expect(f.ports.transcribe).toHaveBeenCalledOnce();
    f.feed(false, 1);
    f.utterance();
    await flush();
    expect(f.ports.transcribe).toHaveBeenCalledTimes(2);
  });

  it('does not let a late submission refusal clear an already playing reply', async () => {
    const f = fixture();
    const submitted = deferred<boolean>();
    f.ports.submit.mockReturnValueOnce(submitted.promise);
    f.utterance();
    await flush();
    f.completed();
    await flush();
    submitted.resolve(false);
    await flush();
    expect(f.view().status).toBe('Speaking locally');
    expect(f.view().error).toBe(false);
  });

  it('requires confirmed cleanup and fresh quiet after retrying a failed stop', async () => {
    const f = fixture();
    f.utterance();
    await flush();
    f.ports.stop.mockRejectedValueOnce(new Error('stop failed'));
    f.controller.stopVoice();
    await flush();
    f.update({
      speech: {
        ...initialSpeechSnapshot(),
        revision: '5',
        state: 'unavailable',
        error: 'unavailable',
      },
    });
    const pending = deferred<void>();
    f.ports.stop.mockReturnValueOnce(pending.promise);
    f.controller.retry();
    expect(f.ports.stop).toHaveBeenCalledTimes(2);
    f.feed(false, 10);
    f.feed(true, 10);
    expect(f.ports.transcribe).toHaveBeenCalledOnce();
    pending.resolve();
    await flush();
    f.update({ speech: { ...initialSpeechSnapshot(), revision: '6' } });
    f.feed(true, 10);
    expect(f.ports.transcribe).toHaveBeenCalledOnce();
    f.feed(false, 1);
    f.utterance();
    await flush();
    expect(f.ports.transcribe).toHaveBeenCalledTimes(2);
  });

  it('never resends uncertain turns and keeps mute scoped to playback', async () => {
    const f = fixture();
    f.controller.setMuted(true);
    f.utterance();
    await flush();
    expect(f.ports.submit).toHaveBeenCalledOnce();
    f.completed();
    expect(f.ports.speak).not.toHaveBeenCalled();
    f.update({ assistant: { ...f.context().assistant, turn: 'uncertain' } });
    f.utterance();
    await flush();
    expect(f.ports.submit).toHaveBeenCalledOnce();
  });
});

describe('spoken prompt composition', () => {
  it.each(['select', 'clear'])(
    'reconciles native state after interrupted %s mutation without dispatch',
    async (operation) => {
      let state!: VoiceComposition;
      let actual: 'terra' | 'sol' = operation === 'clear' ? 'sol' : 'terra';
      const pending = deferred<void>();
      const f = fixture({
        selectSession: async () => {
          await pending.promise;
          actual = 'sol';
          return true;
        },
        clearConversation: async () => {
          await pending.promise;
          actual = 'terra';
          return true;
        },
        readSession: async () => actual,
        onComposition: (next) => {
          state = next;
        },
      });
      f.controller.setDraft('keep raw');
      f.controller.setModel('sol');
      f.ports.transcribe.mockResolvedValueOnce({
        version: 1,
        utterance_id: id,
        text: operation === 'clear' ? 'clear' : 'end prompt',
      });
      f.utterance();
      await flush();
      f.controller.accept({ type: 'reset' });
      pending.resolve();
      await flush();
      expect(state).toMatchObject({
        raw: 'keep raw',
        model: actual,
        status: 'error',
      });
      expect(f.ports.submit).not.toHaveBeenCalled();
    },
  );

  it('reconciles an overlapping capture reset and accepts a settled public clear', async () => {
    const pending = deferred<boolean>();
    let state!: VoiceComposition;
    let actual: 'sol' | 'terra' = 'sol';
    const clearConversation = vi
      .fn()
      .mockImplementationOnce(async () => {
        const accepted = await pending.promise;
        actual = 'terra';
        return accepted;
      })
      .mockResolvedValueOnce(true);
    const f = fixture({
      clearConversation,
      readSession: async () => actual,
      onComposition: (next) => {
        state = next;
      },
    });
    f.controller.setModel('sol');
    const overlapping = f.controller.resetConversation();
    f.controller.accept({ type: 'reset' });
    pending.resolve(true);
    expect(await overlapping).toBe(false);
    expect(state).toMatchObject({ model: 'terra', status: 'error' });
    expect(await f.controller.resetConversation()).toBe(true);
    expect(state).toMatchObject({ model: 'terra', status: 'idle' });
    expect(clearConversation).toHaveBeenCalledTimes(2);
  });

  it('keeps interrupted route unknown without a snapshot until explicit reconciliation', async () => {
    let state!: VoiceComposition;
    const pending = deferred<boolean>();
    const f = fixture({
      selectSession: () => pending.promise,
      onComposition: (next) => {
        state = next;
      },
    });
    f.controller.setDraft('keep');
    f.controller.setModel('sol');
    f.ports.transcribe.mockResolvedValueOnce({
      version: 1,
      utterance_id: id,
      text: 'end prompt',
    });
    f.utterance();
    await flush();
    f.controller.accept({ type: 'reset' });
    pending.resolve(true);
    await flush();
    expect(state.error).toContain('uncertain');
    expect(f.view().status).toContain('Refresh it in the menu');
    f.feed(false, 1);
    f.utterance();
    expect(f.ports.transcribe).toHaveBeenCalledTimes(1);
    f.controller.reconcileSession('sol');
    expect(state).toMatchObject({ model: 'sol', raw: 'keep', status: 'error' });
    f.utterance();
    expect(f.ports.transcribe).toHaveBeenCalledTimes(2);
  });
  it.each(['false', 'throw'])(
    'retains ordinary speech after %s submission and fences replay',
    async (failure) => {
      let state!: VoiceComposition;
      const f = fixture({
        onComposition: (next) => {
          state = next;
        },
      });
      if (failure === 'false') f.ports.submit.mockResolvedValueOnce(false);
      else f.ports.submit.mockRejectedValueOnce(new Error('transport'));
      f.ports.transcribe.mockResolvedValueOnce({
        version: 1,
        utterance_id: id,
        text: '  retained raw  ',
      });
      f.utterance();
      await flush();
      expect(state).toMatchObject({ raw: '  retained raw  ', status: 'error' });
      f.ports.transcribe.mockResolvedValueOnce({
        version: 1,
        utterance_id: id,
        text: 'end prompt',
      });
      f.utterance();
      await flush();
      expect(f.ports.submit).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps Sol selected for an ordinary follow-up after a composed turn', async () => {
    const selectSession = vi.fn(async () => true);
    const f = fixture({ selectSession });
    f.controller.setDraft('first');
    f.controller.setModel('sol');
    f.ports.transcribe.mockResolvedValueOnce({
      version: 1,
      utterance_id: id,
      text: 'end prompt',
    });
    f.utterance();
    await flush();
    f.completed();
    await flush();
    f.update({ speech: { ...initialSpeechSnapshot(), revision: '2' } });
    f.feed(false, 1);
    f.ports.transcribe.mockResolvedValueOnce({
      version: 1,
      utterance_id: id,
      text: 'follow up',
    });
    f.utterance();
    await flush();
    expect(selectSession.mock.calls).toEqual([['sol'], ['sol']]);
  });

  it('keeps playback gated when a composed turn completes before a late refusal', async () => {
    const pending = deferred<boolean>();
    const f = fixture({ selectSession: async () => true });
    f.controller.setDraft('first');
    f.ports.submit.mockReturnValueOnce(pending.promise);
    f.ports.transcribe.mockResolvedValueOnce({
      version: 1,
      utterance_id: id,
      text: 'end prompt',
    });
    f.utterance();
    await flush();
    f.completed();
    await flush();
    pending.resolve(false);
    await flush();
    expect(f.view().status).toBe('Speaking locally');
    f.utterance();
    expect(f.ports.transcribe).toHaveBeenCalledTimes(1);
  });
  it('selects Terra for ordinary speech and retains its original transcript', async () => {
    let state!: VoiceComposition;
    const selectSession = vi.fn(async () => true);
    const f = fixture({
      selectSession,
      onComposition: (next) => {
        state = next;
      },
    });
    f.ports.transcribe.mockResolvedValueOnce({
      version: 1,
      utterance_id: id,
      text: ' ordinary request ',
    });
    f.utterance();
    await flush();
    expect(selectSession).toHaveBeenCalledExactlyOnceWith('terra');
    expect(f.ports.submit).toHaveBeenCalledExactlyOnceWith(
      'ordinary request',
      id,
    );
    expect(state.lastSubmittedRaw).toBe(' ordinary request ');
  });
  it('waits for physical release before transcription and fences cancellation while waiting', async () => {
    const released = deferred<void>();
    const pause = vi.fn();
    const f = fixture({
      onCapturePauseChange: pause,
      waitForCapturePause: () => released.promise,
    });
    f.utterance();
    expect(pause).toHaveBeenLastCalledWith(true);
    expect(f.ports.transcribe).not.toHaveBeenCalled();
    f.controller.accept({ type: 'reset' });
    released.resolve();
    await flush();
    expect(f.ports.transcribe).not.toHaveBeenCalled();
    expect(f.ports.submit).not.toHaveBeenCalled();
  });

  it('begins transcription only after physical release completes', async () => {
    const released = deferred<void>();
    const f = fixture({ waitForCapturePause: () => released.promise });
    f.utterance();
    expect(f.ports.transcribe).not.toHaveBeenCalled();
    released.resolve();
    await flush();
    expect(f.ports.transcribe).toHaveBeenCalledOnce();
  });

  it('keeps listening available when only voice output is muted', () => {
    const pause = vi.fn();
    const f = fixture({ onCapturePauseChange: pause });
    f.controller.setMuted(true);
    expect(pause).not.toHaveBeenCalled();
    f.utterance();
    expect(f.ports.transcribe).toHaveBeenCalledOnce();
  });

  it('preserves an admitted turn through a physical capture pause and an early reply', async () => {
    const transcription = deferred<SpeechTranscript>();
    const admission = deferred<boolean>();
    const pause = vi.fn();
    let composition!: VoiceComposition;
    const f = fixture({
      onCapturePauseChange: pause,
      onComposition: (next) => {
        composition = next;
      },
    });
    f.ports.transcribe.mockReturnValueOnce(transcription.promise);
    f.ports.submit.mockReturnValueOnce(admission.promise);
    f.utterance();
    expect(pause).toHaveBeenLastCalledWith(true);
    f.controller.accept({ type: 'turn-pause' });
    f.update({ audio: { ...f.context().audio, status: 'turn-paused' } });
    transcription.resolve({
      version: 1,
      utterance_id: id,
      text: 'ordinary request',
    });
    await flush();
    expect(f.ports.submit).toHaveBeenCalledExactlyOnceWith(
      'ordinary request',
      id,
    );
    f.completed();
    await flush();
    expect(f.ports.speak).toHaveBeenCalledOnce();
    f.update({
      speech: { ...initialSpeechSnapshot(), revision: '2', state: 'idle' },
    });
    await flush();
    expect(pause).toHaveBeenLastCalledWith(true);
    admission.resolve(true);
    await flush();
    expect(pause).toHaveBeenLastCalledWith(false);
    expect(composition.lastSubmittedRaw).toBe('ordinary request');
    expect(f.ports.submit).toHaveBeenCalledOnce();
  });

  it('aborts refinement on capture loss and fences its late result', async () => {
    let state!: VoiceComposition;
    let signal!: AbortSignal;
    const pending = deferred<string>();
    const f = fixture({
      selectSession: async () => true,
      refinePrompt: (_raw, next) => {
        signal = next;
        return pending.promise;
      },
      onComposition: (next) => {
        state = next;
      },
    });
    f.controller.setDraft('original');
    f.controller.setModel('sol');
    f.ports.transcribe.mockResolvedValueOnce({
      version: 1,
      utterance_id: id,
      text: 'end prompt',
    });
    f.utterance();
    await flush();
    f.controller.accept({ type: 'reset' });
    expect(signal.aborted).toBe(true);
    pending.resolve('late refinement');
    await flush();
    expect(f.ports.submit).not.toHaveBeenCalled();
    expect(state).toMatchObject({ raw: 'original', status: 'error' });
  });

  it('aborts pending refinement on mute and never presents or submits its late result', async () => {
    let signal!: AbortSignal;
    let state!: VoiceComposition;
    const pending = deferred<string>();
    const present = vi.fn(async () => undefined);
    const f = fixture({
      refinePrompt: (_raw, next) => {
        signal = next;
        return pending.promise;
      },
      presentFinalized: present,
      onComposition: (next) => {
        state = next;
      },
    });
    f.controller.setDraft('original');
    f.ports.transcribe.mockResolvedValueOnce({
      version: 1,
      utterance_id: id,
      text: 'end prompt',
    });
    f.utterance();
    await flush();
    expect(state.status).toBe('refining');
    f.controller.setMuted(true);
    expect(signal.aborted).toBe(true);
    pending.resolve('late refinement');
    await flush();
    expect(present).not.toHaveBeenCalled();
    expect(f.ports.submit).not.toHaveBeenCalled();
    expect(state).toMatchObject({ raw: 'original', status: 'error' });
  });

  it.each(['unbind', 'replace'] as const)(
    'fences an existing presentation binding on %s during refinement',
    async (operation) => {
      let signal!: AbortSignal;
      const pending = deferred<string>();
      const present = vi.fn(async () => undefined);
      const replacement = vi.fn(async () => undefined);
      const f = fixture({
        refinePrompt: (_raw, next) => {
          signal = next;
          return pending.promise;
        },
      });
      const unbind = f.controller.bindPromptPresentation(present);
      f.controller.setDraft('original');
      f.ports.transcribe.mockResolvedValueOnce({
        version: 1,
        utterance_id: id,
        text: 'end prompt',
      });
      f.utterance();
      await flush();
      if (operation === 'unbind') unbind();
      else f.controller.bindPromptPresentation(replacement);
      expect(signal.aborted).toBe(true);
      pending.resolve('late refinement');
      await flush();
      expect(present).not.toHaveBeenCalled();
      expect(replacement).not.toHaveBeenCalled();
      expect(f.ports.submit).not.toHaveBeenCalled();
    },
  );

  it('keeps the immediate path when no consumer was bound at finalization start', async () => {
    const pending = deferred<string>();
    const present = vi.fn(async () => undefined);
    const f = fixture({ refinePrompt: () => pending.promise });
    f.controller.setDraft('original');
    f.ports.transcribe.mockResolvedValueOnce({
      version: 1,
      utterance_id: id,
      text: 'end prompt',
    });
    f.utterance();
    await flush();
    f.controller.bindPromptPresentation(present);
    pending.resolve('cleaned');
    await flush();
    expect(present).not.toHaveBeenCalled();
    expect(f.ports.submit).toHaveBeenCalledExactlyOnceWith('cleaned', id);
  });

  it('fences removal of a binding while session selection is still pending', async () => {
    const selected = deferred<boolean>();
    const present = vi.fn(async () => undefined);
    const f = fixture({ selectSession: () => selected.promise });
    const unbind = f.controller.bindPromptPresentation(present);
    f.controller.setDraft('original');
    f.ports.transcribe.mockResolvedValueOnce({
      version: 1,
      utterance_id: id,
      text: 'end prompt',
    });
    f.utterance();
    await flush();
    unbind();
    selected.resolve(true);
    await flush();
    expect(present).not.toHaveBeenCalled();
    expect(f.ports.submit).not.toHaveBeenCalled();
  });

  it('clears a failed presentation’s refined text when speech appends to the draft', async () => {
    let state!: VoiceComposition;
    const f = fixture({
      refinePrompt: async () => 'cleaned',
      presentFinalized: async () => {
        throw new Error('failed');
      },
      onComposition: (next) => {
        state = next;
      },
    });
    f.controller.setDraft('original');
    f.ports.transcribe.mockResolvedValueOnce({
      version: 1,
      utterance_id: id,
      text: 'end prompt',
    });
    f.utterance();
    await flush();
    expect(state).toMatchObject({
      raw: 'original',
      refined: 'cleaned',
      status: 'error',
    });
    f.ports.transcribe.mockResolvedValueOnce({
      version: 1,
      utterance_id: id,
      text: 'more words',
    });
    f.utterance();
    await flush();
    expect(state).toMatchObject({
      raw: 'original\nmore words',
      refined: null,
      status: 'composing',
    });
    expect(f.ports.submit).not.toHaveBeenCalled();
  });

  it('keeps physical capture paused after uncertain dispatch until the draft is edited', async () => {
    const pause = vi.fn();
    const f = fixture({
      selectSession: async () => true,
      onCapturePauseChange: pause,
    });
    f.controller.setDraft('original');
    f.ports.submit.mockResolvedValueOnce(false);
    f.ports.transcribe.mockResolvedValueOnce({
      version: 1,
      utterance_id: id,
      text: 'end prompt',
    });
    f.utterance();
    f.controller.accept({ type: 'turn-pause' });
    f.update({ audio: { ...f.context().audio, status: 'turn-paused' } });
    await flush();
    expect(f.ports.submit).toHaveBeenCalledOnce();
    expect(pause).toHaveBeenLastCalledWith(true);
    f.controller.setDraft('edited');
    expect(pause).toHaveBeenLastCalledWith(false);
  });

  it('keeps an uncertain draft and does not replay without an edit', async () => {
    let state!: VoiceComposition;
    const pending = deferred<boolean>();
    const f = fixture({
      selectSession: async () => true,
      onComposition: (next) => {
        state = next;
      },
    });
    f.controller.setDraft('original');
    f.ports.submit
      .mockResolvedValueOnce(false)
      .mockReturnValueOnce(pending.promise);
    for (let attempt = 0; attempt < 2; attempt++) {
      f.ports.transcribe.mockResolvedValueOnce({
        version: 1,
        utterance_id: id,
        text: 'end prompt',
      });
      f.utterance();
      await flush();
      expect(state.raw).toBe('original');
      f.controller.setDraft('original');
    }
    expect(f.ports.submit).toHaveBeenCalledTimes(1);
    f.controller.setDraft('edited');
    f.ports.transcribe.mockResolvedValueOnce({
      version: 1,
      utterance_id: id,
      text: 'end prompt',
    });
    f.utterance();
    await flush();
    f.controller.accept({ type: 'reset' });
    pending.resolve(true);
    await flush();
    f.feed(false, 1);
    f.ports.transcribe.mockResolvedValueOnce({
      version: 1,
      utterance_id: id,
      text: 'end prompt',
    });
    f.utterance();
    await flush();
    expect(f.ports.submit).toHaveBeenCalledTimes(2);
    expect(state.error).toContain('may have completed');
  });

  it('recognizes only whole commands with punctuation and apostrophe variants', () => {
    for (const text of [
      'done',
      "that's all!",
      'that is all',
      "I'm done.",
      'I am done',
      'clear',
    ])
      expect(voiceCommand(text)).toBe(text === 'clear' ? 'clear' : 'done');
    expect(voiceCommand('Prompt!')).toBe('prompt');
    expect(voiceCommand('end prompt.')).toBe('end prompt');
    expect(voiceCommand('Send!')).toBe('send');
    expect(voiceCommand('SEND, PROMPT.')).toBe('send prompt');
    for (const text of [
      'the prompt is clear',
      'say end prompt now',
      'and prompt',
      'dont send',
      'send me the draft',
      'send prompt now',
      'I am done with this part',
    ])
      expect(voiceCommand(text)).toBeNull();
  });

  it('collects utterances across pauses, dispatches once, and retains raw input for refinement', async () => {
    let state!: VoiceComposition;
    const selectSession = vi.fn(async () => true);
    const refinePrompt = vi.fn(async (raw: string) => `Refined: ${raw}`);
    const f = fixture({
      selectSession,
      refinePrompt,
      onComposition: (next) => {
        state = next;
      },
    });
    const say = async (text: string) => {
      f.ports.transcribe.mockResolvedValueOnce({
        version: 1,
        utterance_id: id,
        text,
      });
      f.utterance();
      await flush();
    };
    await say('prompt');
    await say(' First clause ');
    await say('end prompt is a phrase');
    expect(state.raw).toBe(' First clause \nend prompt is a phrase');
    expect(f.ports.submit).not.toHaveBeenCalled();
    expect(refinePrompt).not.toHaveBeenCalled();
    await say('end prompt');
    expect(selectSession).toHaveBeenCalledExactlyOnceWith('sol');
    expect(refinePrompt).toHaveBeenCalledOnce();
    expect(refinePrompt.mock.calls[0][0]).toBe(
      ' First clause \nend prompt is a phrase',
    );
    expect(f.ports.submit).toHaveBeenCalledExactlyOnceWith(
      'Refined:  First clause \nend prompt is a phrase',
      id,
    );
    expect(state.status).toBe('idle');
    expect(state.lastSubmittedRaw).toBe(
      ' First clause \nend prompt is a phrase',
    );
  });

  it.each(['send', 'send prompt'])(
    'treats %s as one finalization only after a nonempty draft and presentation',
    async (command) => {
      const empty = fixture();
      empty.ports.transcribe.mockResolvedValueOnce({
        version: 1,
        utterance_id: id,
        text: command,
      });
      empty.utterance();
      await flush();
      expect(empty.ports.submit).not.toHaveBeenCalled();

      const done = deferred<void>();
      const refinePrompt = vi.fn(async () => 'cleaned');
      const present = vi.fn(() => done.promise);
      const f = fixture({ refinePrompt, presentFinalized: present });
      f.controller.setDraft('raw text');
      f.ports.transcribe.mockResolvedValueOnce({
        version: 1,
        utterance_id: id,
        text: command,
      });
      f.utterance();
      await flush();
      expect(refinePrompt).toHaveBeenCalledOnce();
      expect(present).toHaveBeenCalledOnce();
      expect(f.ports.submit).not.toHaveBeenCalled();
      f.utterance();
      await flush();
      expect(f.ports.submit).not.toHaveBeenCalled();
      done.resolve();
      await flush();
      expect(f.ports.submit).toHaveBeenCalledExactlyOnceWith('cleaned', id);
    },
  );

  it('waits for the bound presentation before submitting the refined prompt once', async () => {
    let state!: VoiceComposition;
    const done = deferred<void>();
    const present = vi.fn((prompt: unknown, signal: AbortSignal) => {
      void prompt;
      void signal;
      return done.promise;
    });
    const f = fixture({
      refinePrompt: async () => 'cleaned',
      onComposition: (next) => {
        state = next;
      },
    });
    const unbind = f.controller.bindPromptPresentation(present);
    f.controller.setDraft('raw input');
    f.ports.transcribe.mockResolvedValueOnce({
      version: 1,
      utterance_id: id,
      text: 'end prompt',
    });
    f.utterance();
    await flush();
    expect(state).toMatchObject({
      raw: 'raw input',
      refined: 'cleaned',
      status: 'finalizing',
    });
    expect(present).toHaveBeenCalledOnce();
    expect(present.mock.calls[0][0]).toEqual({
      raw: 'raw input',
      refined: 'cleaned',
      model: 'terra',
    });
    expect(f.ports.submit).not.toHaveBeenCalled();
    done.resolve();
    await flush();
    expect(f.ports.submit).toHaveBeenCalledExactlyOnceWith('cleaned', id);
    expect(state).toMatchObject({
      raw: '',
      refined: null,
      lastSubmittedRaw: 'raw input',
    });
    unbind();
  });

  it('keeps physical capture paused throughout presentation and the admitted turn', async () => {
    const pause = vi.fn();
    const done = deferred<void>();
    const f = fixture({
      onCapturePauseChange: pause,
      refinePrompt: async () => 'cleaned',
      presentFinalized: () => done.promise,
    });
    f.controller.setDraft('original');
    f.ports.transcribe.mockResolvedValueOnce({
      version: 1,
      utterance_id: id,
      text: 'end prompt',
    });
    f.utterance();
    expect(pause).toHaveBeenLastCalledWith(true);
    f.controller.accept({ type: 'turn-pause' });
    f.update({ audio: { ...f.context().audio, status: 'turn-paused' } });
    await flush();
    expect(pause).toHaveBeenLastCalledWith(true);
    expect(f.ports.submit).not.toHaveBeenCalled();
    done.resolve();
    await flush();
    expect(f.ports.submit).toHaveBeenCalledExactlyOnceWith('cleaned', id);
    expect(pause).toHaveBeenLastCalledWith(true);
  });

  it('releases the capture pause after presentation fails while retaining the draft', async () => {
    const pause = vi.fn();
    let state!: VoiceComposition;
    const f = fixture({
      onCapturePauseChange: pause,
      refinePrompt: async () => 'cleaned',
      presentFinalized: async () => {
        throw new Error('failed');
      },
      onComposition: (next) => {
        state = next;
      },
    });
    f.controller.setDraft('original');
    f.ports.transcribe.mockResolvedValueOnce({
      version: 1,
      utterance_id: id,
      text: 'end prompt',
    });
    f.utterance();
    f.controller.accept({ type: 'turn-pause' });
    f.update({ audio: { ...f.context().audio, status: 'turn-paused' } });
    await flush();
    expect(f.ports.submit).not.toHaveBeenCalled();
    expect(state).toMatchObject({
      raw: 'original',
      refined: 'cleaned',
      status: 'error',
    });
    expect(pause).toHaveBeenLastCalledWith(false);
  });

  it.each(['reset', 'mute', 'unavailable', 'dispose', 'unbind'] as const)(
    'fences a pending presentation on %s and ignores late completion',
    async (operation) => {
      let state!: VoiceComposition;
      let signal!: AbortSignal;
      const done = deferred<void>();
      const f = fixture({
        refinePrompt: async () => 'cleaned',
        onComposition: (next) => {
          state = next;
        },
      });
      const unbind = f.controller.bindPromptPresentation((_prompt, next) => {
        signal = next;
        return done.promise;
      });
      f.controller.setDraft('raw input');
      f.ports.transcribe.mockResolvedValueOnce({
        version: 1,
        utterance_id: id,
        text: 'end prompt',
      });
      f.utterance();
      await flush();
      expect(state.status).toBe('finalizing');
      if (operation === 'reset') f.controller.accept({ type: 'reset' });
      if (operation === 'mute') f.controller.setMuted(true);
      if (operation === 'unavailable') f.update({ available: false });
      if (operation === 'dispose') f.controller.dispose();
      if (operation === 'unbind') unbind();
      expect(signal.aborted).toBe(true);
      done.resolve();
      await flush();
      expect(f.ports.submit).not.toHaveBeenCalled();
      if (operation !== 'dispose')
        expect(state).toMatchObject({
          raw: 'raw input',
          refined: 'cleaned',
          status: 'error',
        });
    },
  );

  it('retains both versions on presentation failure and on timeout', async () => {
    vi.useFakeTimers();
    try {
      for (const fail of ['reject', 'timeout'] as const) {
        let state!: VoiceComposition;
        let signal!: AbortSignal;
        const done = deferred<void>();
        const f = fixture({
          refinePrompt: async () => 'cleaned',
          onComposition: (next) => {
            state = next;
          },
          presentFinalized: (_prompt, next) => {
            signal = next;
            return fail === 'reject'
              ? Promise.reject(new Error('UI failed'))
              : done.promise;
          },
        });
        f.controller.setDraft('raw input');
        f.ports.transcribe.mockResolvedValueOnce({
          version: 1,
          utterance_id: id,
          text: 'end prompt',
        });
        f.utterance();
        await flush();
        if (fail === 'timeout') await vi.advanceTimersByTimeAsync(10_000);
        await flush();
        expect(state).toMatchObject({
          raw: 'raw input',
          refined: 'cleaned',
          status: 'error',
        });
        expect(state.error).toContain('presentation');
        if (fail === 'timeout') expect(signal.aborted).toBe(true);
        done.resolve();
        await flush();
        expect(f.ports.submit).not.toHaveBeenCalled();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains an over-limit draft without selecting a model or dispatching, and permits editing', async () => {
    let state!: VoiceComposition;
    const selectSession = vi.fn(async () => true);
    const f = fixture({
      selectSession,
      onComposition: (next) => {
        state = next;
      },
    });
    f.controller.setDraft('😀'.repeat(2049));
    expect(state.status).toBe('error');
    f.ports.transcribe.mockResolvedValueOnce({
      version: 1,
      utterance_id: id,
      text: 'end prompt',
    });
    f.utterance();
    await flush();
    expect(state.raw).toBe('😀'.repeat(2049));
    expect(selectSession).not.toHaveBeenCalled();
    expect(f.ports.submit).not.toHaveBeenCalled();
    f.controller.setDraft('recoverable');
    expect(state.status).toBe('composing');
  });

  it('retains text when model selection fails or is unavailable', async () => {
    let state!: VoiceComposition;
    const f = fixture({
      onComposition: (next) => {
        state = next;
      },
    });
    f.controller.setDraft('keep this');
    f.controller.setModel('sol');
    f.ports.transcribe.mockResolvedValueOnce({
      version: 1,
      utterance_id: id,
      text: 'end prompt',
    });
    f.utterance();
    await flush();
    expect(state).toMatchObject({ raw: 'keep this', status: 'error' });
    expect(f.ports.submit).not.toHaveBeenCalled();
  });

  it('fences delayed model selection after capture reset', async () => {
    let state!: VoiceComposition;
    const selected = deferred<boolean>();
    const f = fixture({
      selectSession: () => selected.promise,
      onComposition: (next) => {
        state = next;
      },
    });
    f.controller.setDraft('retain me');
    f.controller.setModel('sol');
    f.ports.transcribe.mockResolvedValueOnce({
      version: 1,
      utterance_id: id,
      text: 'end prompt',
    });
    f.utterance();
    await flush();
    f.controller.accept({ type: 'reset' });
    selected.resolve(true);
    await flush();
    expect(f.ports.submit).not.toHaveBeenCalled();
    expect(state).toMatchObject({ raw: 'retain me', status: 'error' });
  });

  it('clears only after confirmed foreground cleanup and keeps draft on refusal', async () => {
    let state!: VoiceComposition;
    const clearConversation = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const f = fixture({
      clearConversation,
      readSession: async () => 'terra',
      onComposition: (next) => {
        state = next;
      },
    });
    f.controller.setDraft('retain me');
    for (const phrase of ["I'm done", 'clear']) {
      f.ports.transcribe.mockResolvedValueOnce({
        version: 1,
        utterance_id: id,
        text: phrase,
      });
      f.utterance();
      await flush();
      if (phrase === "I'm done") expect(state.raw).toBe('retain me');
    }
    expect(state).toMatchObject({ raw: '', model: 'terra', status: 'idle' });
    expect(f.ports.submit).not.toHaveBeenCalled();
  });
});

describe('native voice lifecycle commands', () => {
  it('matches only standalone commands', () => {
    expect(voiceCommand('Reload MCP!')).toBe('reload mcp');
    expect(voiceCommand('New session.')).toBe('new session');
    expect(voiceCommand('please reload mcp')).toBeNull();
    expect(voiceCommand('describe the new session')).toBeNull();
  });
  it('uses native reset, retains model preferences and then requires a leading Ivy wake word', async () => {
    const newSession = vi.fn(async () => true);
    let composition!: VoiceComposition;
    const f = fixture({
      newSession,
      onComposition: (value) => (composition = value),
    });
    f.controller.initializeSession('sol');
    f.ports.transcribe.mockResolvedValue({
      version: 1,
      utterance_id: id,
      text: 'new session',
    });
    f.utterance();
    await flush();
    expect(newSession).toHaveBeenCalledOnce();
    expect(f.view().passive).toBe(true);
    expect(composition).toMatchObject({
      raw: '',
      status: 'idle',
      model: 'sol',
    });
    f.ports.transcribe.mockResolvedValue({
      version: 1,
      utterance_id: id,
      text: 'ambient conversation',
    });
    f.utterance();
    await flush();
    expect(f.ports.submit).not.toHaveBeenCalled();
    f.ports.transcribe.mockResolvedValue({
      version: 1,
      utterance_id: id,
      text: 'Ivy',
    });
    f.utterance();
    await flush();
    expect(f.view().passive).toBe(false);
    expect(f.ports.submit).not.toHaveBeenCalled();
    f.controller.dispose();
  });
  it('serializes reload, keeps the draft and never submits a control as a prompt', async () => {
    const pending = deferred<boolean>();
    const reloadMcp = vi.fn(() => pending.promise);
    let composition!: VoiceComposition;
    const f = fixture({
      reloadMcp,
      onComposition: (value) => (composition = value),
    });
    f.controller.setDraft('retained draft');
    f.ports.transcribe.mockResolvedValue({
      version: 1,
      utterance_id: id,
      text: 'reload mcp',
    });
    f.utterance();
    await flush();
    expect(reloadMcp).toHaveBeenCalledOnce();
    f.utterance();
    await flush();
    expect(reloadMcp).toHaveBeenCalledOnce();
    pending.resolve(true);
    await flush();
    expect(composition.raw).toBe('retained draft');
    expect(f.view().status).toBe('MCP integrations reloaded.');
    expect(f.ports.submit).not.toHaveBeenCalled();
    f.controller.dispose();
  });
  it('does not clear drafts or claim success after unsupported or failed controls', async () => {
    const f = fixture({
      newSession: async () => false,
      reloadMcp: async () => {
        throw new Error();
      },
    });
    f.controller.setDraft('keep this');
    f.ports.transcribe.mockResolvedValue({
      version: 1,
      utterance_id: id,
      text: 'new session',
    });
    f.utterance();
    await flush();
    expect(f.view().passive).toBe(false);
    expect(f.view().status).toContain('not confirmed');
    f.ports.transcribe.mockResolvedValue({
      version: 1,
      utterance_id: id,
      text: 'reload mcp',
    });
    f.utterance();
    await flush();
    expect(f.view().status).toContain('failed or is unsupported');
    f.controller.dispose();
  });
});

it('applies a reset confirmed through explicit reconciliation after its initial reply was lost', async () => {
  const pending = deferred<boolean>();
  const closed = vi.fn();
  const f = fixture({
    newSession: () => pending.promise,
    onNewSession: closed,
  });
  f.controller.setDraft('old draft');
  f.ports.transcribe.mockResolvedValue({
    version: 1,
    utterance_id: id,
    text: 'new session',
  });
  f.utterance();
  await flush();
  f.update({
    assistant: {
      ...initialIvySnapshot(),
      connection: 'ready',
      turn: 'uncertain',
      turn_id: id,
    },
  });
  pending.resolve(false);
  await flush();
  expect(closed).not.toHaveBeenCalled();
  f.update({
    assistant: {
      ...initialIvySnapshot(),
      connection: 'ready',
      turn: 'idle',
      turn_id: null,
      reset_id: 'stellar-new-confirmed',
    },
  });
  expect(closed).toHaveBeenCalledOnce();
  expect(f.view().passive).toBe(true);
  f.controller.dispose();
});

it('keeps a confirmed native reset authoritative when the command reply is lost afterward', async () => {
  const pending = deferred<boolean>();
  const closed = vi.fn();
  const f = fixture({
    newSession: () => pending.promise,
    onNewSession: closed,
  });
  f.ports.transcribe.mockResolvedValue({
    version: 1,
    utterance_id: id,
    text: 'new session',
  });
  f.utterance();
  await flush();
  f.update({
    assistant: {
      ...initialIvySnapshot(),
      connection: 'ready',
      reset_id: 'stellar-new-confirmed',
    },
  });
  expect(closed).toHaveBeenCalledOnce();
  pending.resolve(false);
  await flush();
  expect(f.view().status).toBe('New session. Say Ivy.');
  expect(closed).toHaveBeenCalledOnce();
  f.controller.dispose();
});
