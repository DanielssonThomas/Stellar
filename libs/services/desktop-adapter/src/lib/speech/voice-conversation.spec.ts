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

describe('local Reflex admission', () => {
  const settle = async () => {
    for (let i = 0; i < 8; i++) await flush();
  };
  it('runs after wake admission without selecting a cloud session or submitting Hermes', async () => {
    const reflex = vi.fn(async () => ({
      handled: true,
      outcome: 'confirmed' as const,
      reply: 'Much better.',
    }));
    const selectSession = vi.fn(async () => true);
    const f = fixture({ reflex, selectSession });
    f.ports.transcribe.mockResolvedValue({
      version: 1,
      utterance_id: id,
      text: 'Ivy, skip this garbage.',
    });
    f.utterance();
    await settle();
    expect(reflex).toHaveBeenCalledOnce();
    expect(f.ports.speak).toHaveBeenCalledWith('Much better.', id);
    expect(selectSession).not.toHaveBeenCalled();
    expect(f.ports.submit).not.toHaveBeenCalled();
    f.controller.dispose();
  });
  it('never lets ambient speech or Prompt dictation invoke local actions', async () => {
    const reflex = vi.fn(async () => ({
      handled: true,
      outcome: 'confirmed' as const,
      reply: 'Done.',
    }));
    const f = fixture({ reflex });
    f.ports.transcribe.mockResolvedValue({
      version: 1,
      utterance_id: id,
      text: 'skip this garbage',
    });
    f.utterance();
    await settle();
    expect(reflex).not.toHaveBeenCalled();
    f.controller.setDraft('skip the next track');
    f.utterance();
    await settle();
    expect(reflex).not.toHaveBeenCalled();
    f.controller.dispose();
  });
  it('admits local commands offline while keeping uncertain turns fenced', async () => {
    const reflex = vi.fn(async () => ({
      handled: true,
      outcome: 'clarify' as const,
      reply: 'Which pane?',
    }));
    const f = fixture({ reflex });
    f.update({
      localAvailable: true,
      assistant: { ...f.context().assistant, connection: 'unavailable' },
    });
    f.utterance();
    await settle();
    expect(reflex).toHaveBeenCalledOnce();
    expect(f.ports.submit).not.toHaveBeenCalled();
    f.controller.dispose();
  });
  it('reconciles local playback that completed before its older speech reply arrived', async () => {
    const pending = deferred<SpeechSnapshot>();
    const speak = vi.fn(() => pending.promise);
    const reflex = vi.fn(async () => ({
      handled: true,
      outcome: 'confirmed' as const,
      reply: 'Much better.',
    }));
    const f = fixture({ speak, reflex });
    f.utterance();
    await settle();
    expect(speak).toHaveBeenCalledOnce();
    f.update({
      speech: {
        ...initialSpeechSnapshot(),
        state: 'idle',
        operation_id: id,
        revision: '6',
      },
    });
    pending.resolve({
      ...initialSpeechSnapshot(),
      state: 'speaking',
      operation_id: id,
      revision: '5',
    });
    await settle();
    expect(f.view().busy).toBe(false);
    f.feed(false, 1);
    f.utterance();
    await settle();
    expect(reflex).toHaveBeenCalledTimes(2);
    expect(f.ports.submit).not.toHaveBeenCalled();
    f.controller.dispose();
  });
  it('cancels inference on a microphone reset and suppresses a late acknowledgment', async () => {
    const pending = deferred<{
      handled: boolean;
      outcome: 'confirmed';
      reply: string;
    }>();
    let signal!: AbortSignal;
    const reflex = vi.fn((_text: string, _id: string, next: AbortSignal) => {
      signal = next;
      return pending.promise;
    });
    const f = fixture({ reflex });
    f.utterance();
    await settle();
    f.controller.accept({ type: 'reset' });
    expect(signal.aborted).toBe(true);
    pending.resolve({ handled: true, outcome: 'confirmed', reply: 'Done.' });
    await settle();
    expect(f.ports.speak).not.toHaveBeenCalled();
    expect(f.ports.submit).not.toHaveBeenCalled();
    f.controller.dispose();
  });
});

describe('dedicated command recognition integration', () => {
  it('does not open a prompt for out-of-context cancel immediately after acoustic Ivy', async () => {
    const collect = vi.fn(async (_pcm: Int16Array, utterance_id: string) => ({
      version: 1,
      utterance_id,
      text: 'prompt cancel',
    }));
    const f = fixture({
      keywords: async (_pcm, _stream, sequence, _threshold, mode) => ({
        sequence,
        detection:
          mode === 'passive' ? { command: 'ivy', end_sample: 0 } : null,
      }),
      collect,
    });
    f.feed(true, 1);
    await settle();
    f.feed(true, 8);
    f.feed(false, 40);
    await settle();
    expect(f.composition().status).not.toBe('composing');
    expect(f.ports.submit).toHaveBeenCalledExactlyOnceWith('prompt cancel', id);
    f.controller.dispose();
  });
  it('retains a native prompt-cancel fragment at a long-dictation cap and its continuation', async () => {
    const ended = vi.fn();
    const collect = vi.fn(async (_pcm: Int16Array, utterance_id: string) => ({
      version: 1,
      utterance_id,
      text: 'prompt cancel',
    }));
    const f = fixture({
      keywords: async (_pcm, _stream, sequence) => ({
        sequence,
        detection: null,
      }),
      collect,
      onForegroundEnd: ended,
    });
    f.controller.setDraft('Retain this draft');
    for (let frame = 0; frame < 550; frame++) {
      f.feed(true, 1);
      await flush();
    }
    f.feed(false, 40);
    await settle();
    expect(f.composition().status).toBe('composing');
    expect(f.composition().raw).toContain('Retain this draft');
    expect(f.composition().raw).toContain('prompt cancel');
    expect(f.view().error).toBe(false);
    expect(ended).not.toHaveBeenCalled();
    expect(f.ports.submit).not.toHaveBeenCalled();
    f.controller.dispose();
  });
  it('routes the request following acoustic Ivy into the existing prompt foreground', async () => {
    const ended = vi.fn();
    const collect = vi.fn(async (_pcm: Int16Array, utterance_id: string) => ({
      version: 1,
      utterance_id,
      text: 'prompt write a note',
    }));
    const f = fixture({
      keywords: async (_pcm, _stream, sequence, _threshold, mode) => ({
        sequence,
        detection:
          mode === 'passive' ? { command: 'ivy', end_sample: 0 } : null,
      }),
      collect,
      onForegroundEnd: ended,
    });
    f.feed(true, 1);
    await settle();
    expect(f.view().foregroundActive).toBe(true);
    expect(collect).not.toHaveBeenCalled();
    f.feed(true, 8);
    f.feed(false, 40);
    await settle();
    expect(f.composition()).toMatchObject({
      raw: 'write a note',
      model: 'sol',
      status: 'composing',
    });
    expect(f.ports.submit).not.toHaveBeenCalled();
    collect.mockResolvedValue({
      version: 1,
      utterance_id: id,
      text: 'Explain how to say prompt cancel',
    });
    f.utterance();
    await settle();
    expect(f.composition().status).toBe('composing');
    expect(ended).not.toHaveBeenCalled();
    collect.mockResolvedValue({
      version: 1,
      utterance_id: id,
      text: 'prompt cancel',
    });
    f.utterance();
    await settle();
    expect(f.composition()).toMatchObject({ raw: '', status: 'idle' });
    expect(f.view().foregroundActive).toBe(true);
    expect(ended).not.toHaveBeenCalled();
    f.controller.dispose();
  });
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
    expect(f.view().passive).toBe(false);
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
  it.each([false, true])(
    'cancels composition through KWS with established Sol = %s',
    async (establishedSol) => {
      const refine = vi.fn(async (raw: string) => raw);
      const f = fixture({
        keywords: async (_pcm, _stream, sequence) => ({
          sequence,
          detection: { command: 'prompt cancel', end_sample: 640 },
        }),
        refinePrompt: refine,
      });
      if (establishedSol) f.controller.initializeSession('sol');
      f.controller.setModel('sol');
      f.controller.setDraft('Keep this only until cancelled');
      f.feed(true, 1);
      f.feed(false, 25);
      await settle();
      expect(f.composition()).toMatchObject({
        raw: '',
        refined: null,
        status: 'idle',
      });
      expect(f.view().passive).toBe(establishedSol);
      expect(f.composition().model).toBe('terra');
      expect(refine).not.toHaveBeenCalled();
      expect(f.ports.transcribe).not.toHaveBeenCalled();
      expect(f.ports.submit).not.toHaveBeenCalled();
      f.controller.dispose();
    },
  );
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
      text: 'Ivy, A spoken request',
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

describe('voice volume ducking intent', () => {
  it('keeps passive speech untouched and ducks an admitted voice turn through playback', async () => {
    const f = fixture();
    f.feed(true, 5);
    expect(f.view().ducking).toBe(false);
    f.feed(false, 35);
    await flush();
    expect(f.view().ducking).toBe(true);
    f.completed();
    await flush();
    expect(f.view().ducking).toBe(true);
    f.update({
      speech: {
        ...initialSpeechSnapshot(),
        state: 'speaking',
        revision: '2',
        operation_id: id,
      },
    });
    expect(f.view().ducking).toBe(true);
    f.update({
      speech: {
        ...initialSpeechSnapshot(),
        state: 'idle',
        revision: '3',
        operation_id: id,
      },
    });
    expect(f.view().ducking).toBe(false);
    f.controller.dispose();
  });

  it('ducks foreground speech, permits brief quiet, and releases on failure, stop and suspension', async () => {
    for (const end of ['stop', 'failure', 'suspend', 'capture'] as const) {
      const f = fixture();
      f.controller.setDraft('foreground draft');
      f.feed(true, 1);
      expect(f.view().ducking).toBe(true);
      f.feed(false, 1);
      expect(f.view()).toMatchObject({
        ducking: false,
        duckingListening: true,
      });
      if (end === 'stop') f.controller.stopVoice();
      if (end === 'failure') f.controller.accept({ type: 'unavailable' });
      if (end === 'suspend') f.update({ available: false });
      if (end === 'capture')
        f.update({ audio: { ...f.context().audio, status: 'idle' } });
      expect(f.view().ducking).toBe(false);
      expect(f.view().duckingListening).toBe(false);
      f.controller.dispose();
    }
  });
});

describe('wake-word session lifecycle', () => {
  it('shows raw Whisper previews and final words without admitting passive speech', async () => {
    const collect = vi.fn(async (_pcm: Int16Array, utterance_id: string) => ({
      version: 1,
      utterance_id,
      text: 'miss herd words',
    }));
    const f = fixture({ collect });
    f.feed(true, 13);
    await flush();
    expect(f.view().inputText).toBe('miss herd words');
    expect(f.view().foregroundActive).toBe(false);
    expect(f.ports.submit).not.toHaveBeenCalled();
    collect.mockResolvedValue({
      version: 1,
      utterance_id: id,
      text: 'Ivy, miss herd the request.',
    });
    f.feed(false, 35);
    await flush();
    expect(f.view().inputText).toBe('Ivy, miss herd the request.');
    expect(f.ports.submit).toHaveBeenCalledExactlyOnceWith(
      'miss herd the request.',
      id,
    );
    f.controller.accept({ type: 'reset' });
    expect(f.view().inputText).toBe('');
  });

  it('discards the transcript on prompt entry and does not expose cancelled prompt dictation', async () => {
    const f = setup();
    await f.say('unrelated background input');
    expect(f.view().inputText).toBe('unrelated background input');
    await f.say('Ivy, prompt');
    expect(f.view().inputText).toBe('');
    await f.say('private prompt words');
    expect(f.view().inputText).toBe('');
    await f.say('prompt cancel');
    expect(f.view().inputText).toBe('');
    expect(f.ports.submit).not.toHaveBeenCalled();
    f.feed(false, 1);
    await f.say('the next Terra sentence');
    expect(f.view().inputText).toBe('the next Terra sentence');
    expect(f.view().foregroundActive).toBe(true);
  });

  it('trusts the first Ivy hit without requiring a repeated wake in the final transcript', async () => {
    const states: VoiceView[] = [];
    const collect = vi
      .fn(async (_pcm: Int16Array, utterance_id: string) => ({
        version: 1,
        utterance_id,
        text: 'tell me the plan',
      }))
      .mockResolvedValueOnce({ version: 1, utterance_id: id, text: 'Ivy' });
    const f = fixture({ collect, onChange: (state) => states.push(state) });
    f.feed(true, 13);
    for (let i = 0; i < 3; i++) await flush();
    expect(states.at(-1)?.foregroundActive).toBe(true);
    f.feed(false, 35);
    for (let i = 0; i < 3; i++) await flush();
    expect(states.at(-1)?.foregroundActive).toBe(true);
    expect(f.ports.submit).toHaveBeenCalledExactlyOnceWith(
      'tell me the plan',
      id,
    );
  });

  it('accepts a wake hit that arrives after quiet has queued the full sentence', async () => {
    const hit = deferred<{
      version: number;
      utterance_id: string;
      text: string;
    }>();
    const final = deferred<{
      version: number;
      utterance_id: string;
      text: string;
    }>();
    const collect = vi
      .fn()
      .mockReturnValueOnce(hit.promise)
      .mockReturnValueOnce(final.promise);
    const f = fixture({ collect });
    f.feed(true, 13);
    expect(collect).toHaveBeenCalledOnce();
    f.feed(false, 35);
    expect(f.ports.stop).not.toHaveBeenCalled();
    hit.resolve({ version: 1, utterance_id: id, text: 'Ivy' });
    await flush();
    expect(f.view().foregroundActive).toBe(true);
    expect(f.ports.submit).not.toHaveBeenCalled();
    expect(collect).toHaveBeenCalledTimes(2);
    final.resolve({ version: 1, utterance_id: id, text: 'explain the plan' });
    await flush();
    expect(f.ports.submit).toHaveBeenCalledExactlyOnceWith(
      'explain the plan',
      id,
    );
  });

  it('does not revive foreground from a wake preview after the microphone is stopped', async () => {
    const hit = deferred<{
      version: number;
      utterance_id: string;
      text: string;
    }>();
    const f = fixture({ collect: () => hit.promise });
    f.feed(true, 13);
    f.controller.accept({ type: 'reset' });
    hit.resolve({ version: 1, utterance_id: id, text: 'Ivy' });
    await flush();
    expect(f.view().foregroundActive).toBe(false);
    expect(f.ports.submit).not.toHaveBeenCalled();
  });

  it('activates from an in-progress Ivy prefix and stays active across recognition, thinking and playback', async () => {
    const states: VoiceView[] = [];
    const collect = vi.fn(async (_pcm: Int16Array, utterance_id: string) => ({
      version: 1,
      utterance_id,
      text: 'Ivy, a normal request',
    }));
    const clearConversation = vi.fn(async () => true);
    const f = fixture({
      collect,
      clearConversation,
      onChange: (state) => states.push(state),
    });
    f.feed(true, 30);
    for (let i = 0; i < 3; i++) await flush();
    expect(states.at(-1)?.foregroundActive).toBe(true);
    expect(f.ports.submit).not.toHaveBeenCalled();
    const activeFrom = states.length - 1;
    f.feed(true, 15);
    f.feed(false, 35);
    for (let i = 0; i < 3; i++) await flush();
    expect(f.ports.submit).toHaveBeenCalledExactlyOnceWith(
      'a normal request',
      id,
    );
    const recognized = collect.mock.calls.length;
    f.update({
      assistant: { ...f.context().assistant, turn: 'admitted', turn_id: id },
    });
    f.feed(true, 50);
    expect(collect).toHaveBeenCalledTimes(recognized);
    f.completed();
    await flush();
    f.update({
      speech: { ...initialSpeechSnapshot(), state: 'speaking', revision: '2' },
    });
    f.feed(true, 50);
    expect(collect).toHaveBeenCalledTimes(recognized);
    f.update({
      speech: { ...initialSpeechSnapshot(), state: 'idle', revision: '3' },
    });
    f.feed(false, 35);
    expect(
      states.slice(activeFrom).every((state) => state.foregroundActive),
    ).toBe(true);
    expect(f.context().audio.status).toBe('capturing');
    collect.mockResolvedValue({
      version: 1,
      utterance_id: id,
      text: "I'm done",
    });
    f.utterance();
    for (let i = 0; i < 4; i++) await flush();
    expect(clearConversation).toHaveBeenCalledOnce();
    expect(states.at(-1)?.foregroundActive).toBe(false);
    expect(f.context().audio.status).toBe('capturing');
  });

  function setup(extra: Partial<VoicePorts> = {}) {
    let composition: VoiceComposition | undefined;
    const selectSession = vi.fn(async () => true);
    const clearConversation = vi.fn(async () => true);
    const refinePrompt = vi.fn(async (raw: string) => raw);
    const onForegroundEnd = vi.fn();
    const f = fixture({
      selectSession,
      clearConversation,
      refinePrompt,
      onForegroundEnd,
      onComposition: (value) => {
        composition = value;
      },
      ...extra,
    });
    const say = async (text: string) => {
      f.ports.transcribe.mockResolvedValueOnce({
        version: 1,
        utterance_id: id,
        text,
      });
      f.utterance();
      for (let i = 0; i < 3; i++) await flush();
    };
    const settle = () =>
      f.update({
        assistant: {
          ...f.context().assistant,
          turn: 'completed',
          turn_id: id,
          items: [],
        },
      });
    return {
      ...f,
      say,
      settle,
      selectSession,
      clearConversation,
      refinePrompt,
      onForegroundEnd,
      composition: () => composition,
    };
  }

  it('never opens a session or cleans ambient speech', async () => {
    const f = setup();
    for (const text of [
      'ordinary background speech',
      'prompt',
      'ivory',
      'I have a plan',
      'I mean',
      'I mean, explain this',
      "Ivy's leaves",
      'tell Ivy to start',
      'send prompt',
    ])
      await f.say(text);
    expect(f.selectSession).not.toHaveBeenCalled();
    expect(f.ports.submit).not.toHaveBeenCalled();
    expect(f.refinePrompt).not.toHaveBeenCalled();
    expect(f.view()).toMatchObject({
      foregroundActive: false,
      status: 'Listening for Ivy',
    });
  });

  it('Ivy plus a normal request starts Terra, preserves follow-ups, and resets after clear', async () => {
    const f = setup();
    f.controller.initializeSession('sol');
    await f.say('Ivy, explain the plan');
    expect(f.selectSession).toHaveBeenCalledExactlyOnceWith('terra');
    expect(f.ports.submit).toHaveBeenCalledExactlyOnceWith(
      'explain the plan',
      id,
    );
    f.settle();
    await f.say('and tomorrow?');
    expect(f.ports.submit).toHaveBeenLastCalledWith('and tomorrow?', id);
    f.settle();
    await f.say('clear');
    expect(f.clearConversation).toHaveBeenCalledOnce();
    await f.say('unrelated ambient words');
    expect(f.ports.submit).toHaveBeenCalledTimes(2);
    expect(f.view().foregroundActive).toBe(false);
    await f.say('Ivy, start again');
    expect(f.ports.submit).toHaveBeenLastCalledWith('start again', id);
  });

  it('routes dotted I.V. to Terra and resumes it after cancelling the first Sol draft', async () => {
    const f = setup();
    await f.say('I.V, explain the plan');
    expect(f.view().inputText).toBe('I.V, explain the plan');
    expect(f.selectSession).toHaveBeenCalledExactlyOnceWith('terra');
    expect(f.ports.submit).toHaveBeenCalledExactlyOnceWith(
      'explain the plan',
      id,
    );
    f.settle();
    await f.say('done');
    await f.say('I mean, another request');
    expect(f.ports.submit).toHaveBeenCalledOnce();
    await f.say('I.V., prompt new draft');
    expect(f.composition()).toMatchObject({
      model: 'sol',
      status: 'composing',
      raw: 'new draft',
    });
    await f.say('prompt cancel');
    expect(f.view().foregroundActive).toBe(true);
    f.feed(false, 1);
    await f.say('prompt');
    expect(f.composition()?.status).toBe('composing');
    expect(f.ports.submit).toHaveBeenCalledOnce();
  });

  it.each([
    'done',
    "that's all",
    "I'm done",
    'that is all',
    'I am done',
    "alright I'm done",
    'all right I am done',
  ])('requires a fresh wake after %s', async (command) => {
    const f = setup();
    await f.say('Ivy');
    expect(f.ports.submit).not.toHaveBeenCalled();
    await f.say(command);
    await f.say('new request');
    expect(f.ports.submit).not.toHaveBeenCalled();
    expect(f.view().foregroundActive).toBe(false);
  });

  it('retains foreground invocation across long pauses until explicit completion', async () => {
    vi.useFakeTimers();
    const f = setup();
    await f.say('Ivy');
    vi.advanceTimersByTime(600_000);
    expect(f.view().foregroundActive).toBe(true);
    await f.say('follow-up after a long pause');
    expect(f.ports.submit).toHaveBeenCalledExactlyOnceWith(
      'follow-up after a long pause',
      id,
    );
    f.settle();
    await f.say('Ivy, prompt first clause');
    vi.advanceTimersByTime(600_000);
    await f.say('Ivy is part of this draft');
    expect(f.composition()?.raw).toBe(
      'first clause\nIvy is part of this draft',
    );
    expect(f.ports.submit).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it.each([
    'prompt cancel',
    'Do not send this. Prompt cancel.',
    'Changed my mind, prompt cancel. Send prompt.',
  ])(
    'discards composition on %s without cleanup or dispatch',
    async (command) => {
      const f = setup();
      await f.say('Ivy, prompt');
      expect(f.composition()).toMatchObject({
        model: 'sol',
        status: 'composing',
      });
      await f.say('buffered words');
      await f.say(command);
      expect(f.composition()).toEqual({
        raw: '',
        refined: null,
        lastSubmittedRaw: '',
        model: 'terra',
        status: 'idle',
        error: '',
      });
      expect(f.refinePrompt).not.toHaveBeenCalled();
      expect(f.selectSession).not.toHaveBeenCalled();
      expect(f.ports.submit).not.toHaveBeenCalled();
      expect(f.onForegroundEnd).not.toHaveBeenCalled();
      expect(f.view()).toMatchObject({
        foregroundActive: true,
        passive: false,
      });
      f.feed(false, 1);
      await f.say('prompt');
      await f.say('another first draft');
      expect(f.ports.submit).not.toHaveBeenCalled();
      await f.say('prompt cancel');
      f.feed(false, 1);
      expect(f.composition()).toMatchObject({
        raw: '',
        model: 'terra',
        status: 'idle',
      });
      await f.say('continue the Terra conversation');
      expect(f.ports.submit).toHaveBeenCalledExactlyOnceWith(
        'continue the Terra conversation',
        id,
      );
      expect(f.selectSession).toHaveBeenCalledExactlyOnceWith('terra');
    },
  );

  it.each(['submitted', 'restored'] as const)(
    'retains passive cancellation after an established %s Sol session',
    async (source) => {
      const f = setup();
      if (source === 'restored') f.controller.initializeSession('sol');
      else {
        await f.say('Ivy, prompt first Sol request');
        await f.say('send prompt');
        expect(f.ports.submit).toHaveBeenCalledOnce();
        f.settle();
      }
      await f.say('Ivy, prompt discard this');
      const submissions = f.ports.submit.mock.calls.length;
      await f.say('prompt cancel');
      expect(f.view()).toMatchObject({
        foregroundActive: false,
        passive: true,
      });
      expect(f.onForegroundEnd).toHaveBeenCalledOnce();
      expect(f.ports.submit).toHaveBeenCalledTimes(submissions);
    },
  );

  it.each(['clear', 'new session'] as const)(
    'resets first-prompt cancellation after confirmed %s',
    async (command) => {
      const f = setup({ newSession: async () => true });
      f.controller.initializeSession('sol');
      await f.say('Ivy');
      await f.say(command);
      f.feed(false, 1);
      await f.say('Ivy, prompt new first draft');
      await f.say('prompt cancel');
      expect(f.view()).toMatchObject({
        foregroundActive: true,
        passive: false,
      });
      expect(f.composition()).toMatchObject({
        model: 'terra',
        raw: '',
        status: 'idle',
      });
      expect(f.ports.submit).not.toHaveBeenCalled();
    },
  );

  it('treats prompt cancel as ordinary conversation outside composition', async () => {
    const f = setup();
    await f.say('Ivy, explain the prompt cancel command');
    f.settle();
    await f.say('prompt cancel');
    expect(f.ports.submit).toHaveBeenLastCalledWith('prompt cancel', id);
    expect(f.onForegroundEnd).not.toHaveBeenCalled();
  });

  it('aborts an already pending live cleanup and fences its late result', async () => {
    const cleanup = deferred<string>();
    let signal!: AbortSignal;
    const collect = vi.fn(async (_pcm: Int16Array, utterance_id: string) => ({
      version: 1,
      utterance_id,
      text: 'first sentence',
    }));
    const refinePrompt = vi.fn((_raw: string, next: AbortSignal) => {
      signal = next;
      return cleanup.promise;
    });
    const f = setup({ collect, refinePrompt });
    f.controller.setDraft('seed');
    f.utterance();
    for (let i = 0; i < 3; i++) await flush();
    expect(refinePrompt).toHaveBeenCalledOnce();
    collect.mockResolvedValue({
      version: 1,
      utterance_id: id,
      text: 'prompt cancel',
    });
    f.utterance();
    for (let i = 0; i < 3; i++) await flush();
    expect(signal.aborted).toBe(true);
    cleanup.resolve('late cancelled text');
    await flush();
    expect(f.composition()).toMatchObject({
      raw: '',
      refined: null,
      status: 'idle',
    });
    expect(refinePrompt).toHaveBeenCalledOnce();
    expect(f.ports.submit).not.toHaveBeenCalled();
  });

  it('keeps passive capture live and queues the request spoken just after Ivy', async () => {
    const first = deferred<SpeechTranscript>();
    const collect = vi
      .fn(async (_pcm: Int16Array, utterance_id: string) => ({
        version: 1,
        utterance_id,
        text: 'Ivy, prompt',
      }))
      .mockReturnValueOnce(first.promise);
    const pause = vi.fn();
    const f = setup({ collect, onCapturePauseChange: pause });
    f.utterance();
    f.utterance();
    expect(pause).not.toHaveBeenCalled();
    expect(f.selectSession).not.toHaveBeenCalled();
    first.resolve({
      version: 1,
      utterance_id: id,
      text: 'ordinary ambient speech',
    });
    for (let i = 0; i < 5; i++) await flush();
    expect(collect).toHaveBeenCalledTimes(2);
    expect(f.composition()).toMatchObject({
      model: 'sol',
      status: 'composing',
      raw: '',
    });
    expect(pause).not.toHaveBeenCalled();
    expect(f.ports.submit).not.toHaveBeenCalled();
  });

  it('releases continuous capture before an ordinary active-session phrase starting with prompt', async () => {
    const released = deferred<void>();
    const collect = vi.fn(async (_pcm: Int16Array, utterance_id: string) => ({
      version: 1,
      utterance_id,
      text: 'Ivy',
    }));
    const pause = vi.fn();
    const f = setup({
      collect,
      onCapturePauseChange: pause,
      waitForCapturePause: () => released.promise,
    });
    f.utterance();
    for (let i = 0; i < 3; i++) await flush();
    expect(f.view().foregroundActive).toBe(true);
    collect.mockResolvedValue({
      version: 1,
      utterance_id: id,
      text: 'prompt cancel',
    });
    f.utterance();
    await flush();
    expect(pause).toHaveBeenLastCalledWith(true);
    expect(f.ports.submit).not.toHaveBeenCalled();
    released.resolve();
    for (let i = 0; i < 3; i++) await flush();
    expect(f.ports.submit).toHaveBeenCalledExactlyOnceWith('prompt cancel', id);
    expect(f.onForegroundEnd).not.toHaveBeenCalled();
  });

  it('keeps cancellation vocabulary inside an explanatory sentence as dictation', async () => {
    const f = setup();
    await f.say('Ivy, prompt');
    await f.say('Explain the prompt cancel command in the documentation');
    expect(f.composition()?.raw).toBe(
      'Explain the prompt cancel command in the documentation',
    );
    expect(f.onForegroundEnd).not.toHaveBeenCalled();
    expect(f.ports.submit).not.toHaveBeenCalled();
  });
});

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
  it('admits a leading wake in the first capped chunk even when its preview missed it', async () => {
    const collect = vi.fn(async (pcm: Int16Array, utterance_id: string) => ({
      version: 1,
      utterance_id,
      text: pcm.length >= 320000 ? 'Ivy, explain the plan' : '',
    }));
    const f = fixture({ collect });
    f.feed(true, 500);
    for (let i = 0; i < 8; i++) await flush();
    expect(f.view().foregroundActive).toBe(true);
    expect(f.ports.submit).toHaveBeenCalledExactlyOnceWith(
      'explain the plan',
      id,
    );
  });

  it('does not scan continuing passive speech for a new wake after the initial cap', async () => {
    let finals = 0;
    const collect = vi.fn(async (pcm: Int16Array, utterance_id: string) => ({
      version: 1,
      utterance_id,
      text: pcm.length >= 320000 && ++finals > 1 ? 'Ivy, explain the plan' : '',
    }));
    const f = fixture({ collect });
    f.feed(true, 500);
    for (let i = 0; i < 8; i++) await flush();
    f.feed(true, 500);
    for (let i = 0; i < 8; i++) await flush();
    expect(finals).toBe(1);
    expect(f.view().foregroundActive).toBe(false);
    expect(f.ports.submit).not.toHaveBeenCalled();
    f.feed(false, 35);
    for (let i = 0; i < 4; i++) await flush();
    collect.mockImplementation(async (_pcm, utterance_id) => ({
      version: 1,
      utterance_id,
      text: 'Ivy, explain the plan',
    }));
    f.utterance();
    for (let i = 0; i < 8; i++) await flush();
    expect(f.ports.submit).toHaveBeenCalledExactlyOnceWith(
      'explain the plan',
      id,
    );
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
      text: 'Ivy, prompt',
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

  it.each([false, true])(
    'serializes post-wake draft collection behind passive diagnostics (reset queued: %s)',
    async (resetQueued) => {
      const passive = deferred<void>();
      let active = false;
      let collisions = 0;
      let wakeNext = false;
      const buffers: Int16Array[] = [];
      const collect = vi.fn(async (pcm: Int16Array, utterance_id: string) => {
        if (active) {
          collisions++;
          throw new Error('SpeechHost busy');
        }
        active = true;
        buffers.push(pcm);
        try {
          if (buffers.length === 1) {
            await passive.promise;
            return { version: 1, utterance_id, text: 'Ambient speech' };
          }
          expect(pcm.some((sample) => sample !== 0)).toBe(true);
          return { version: 1, utterance_id, text: 'A short spoken request' };
        } finally {
          active = false;
        }
      });
      const f = fixture({
        collect,
        keywords: async (_pcm, _stream, sequence) => {
          const detection = wakeNext
            ? { command: 'ivy' as const, end_sample: (sequence + 1) * 640 }
            : null;
          wakeNext = false;
          return { sequence, detection };
        },
      });
      const settle = async () => {
        for (let i = 0; i < 8; i++) await flush();
      };
      f.controller.setRecognitionOptions('high', true);
      f.feed(true, 8);
      f.feed(false, 35);
      await settle();
      expect(collect).toHaveBeenCalledOnce();
      wakeNext = true;
      f.feed(true, 1);
      await settle();
      expect(f.view().foregroundActive).toBe(true);
      f.feed(true, 8);
      f.feed(false, 40);
      await settle();
      expect(collect).toHaveBeenCalledOnce();
      expect(collisions).toBe(0);
      expect(f.view().error).toBe(false);
      if (resetQueued) f.controller.accept({ type: 'reset' });
      passive.resolve();
      await settle();
      expect(collisions).toBe(0);
      expect(f.view().error).toBe(false);
      expect(collect).toHaveBeenCalledTimes(resetQueued ? 1 : 2);
      if (resetQueued) expect(f.ports.submit).not.toHaveBeenCalled();
      else
        expect(f.ports.submit).toHaveBeenCalledExactlyOnceWith(
          'A short spoken request',
          id,
        );
      expect(buffers.every((pcm) => pcm.every((sample) => sample === 0))).toBe(
        true,
      );
      f.controller.dispose();
    },
  );

  it('keeps passive diagnostics local and selects the high-sensitivity wake-only mode', async () => {
    const observations = vi.fn();
    const collect = vi.fn(async (_pcm: Int16Array, utterance_id: string) => ({
      version: 1,
      utterance_id,
      text: 'I mean, send this passive text',
    }));
    const keywords = vi.fn(
      async (
        _pcm: Int16Array,
        _stream: string,
        sequence: number,
        threshold: number,
        mode: unknown,
      ) => {
        void threshold;
        void mode;
        return { sequence, detection: null };
      },
    );
    const f = fixture({ collect, keywords, onRecognition: observations });
    f.controller.setRecognitionOptions('high', true);
    f.utterance();
    await flush();
    expect(collect).toHaveBeenCalledOnce();
    expect(observations).toHaveBeenCalledWith({
      text: 'I mean, send this passive text',
      status: 'No wake detected',
    });
    expect(f.ports.submit).not.toHaveBeenCalled();
    expect(
      keywords.mock.calls.some((call) => call[4] === 'passive_sensitive'),
    ).toBe(true);
    f.controller.setRecognitionOptions('standard', false);
    f.utterance();
    await flush();
    expect(collect).toHaveBeenCalledOnce();
    f.controller.dispose();
  });

  it.each(['Hello', 'Hello there', 'Thanks', 'Cancel that'])(
    'never adds waiting speech to an admitted %s turn',
    async (text) => {
      vi.useFakeTimers();
      const f = fixture();
      try {
        f.ports.transcribe.mockResolvedValueOnce({
          version: 1,
          utterance_id: id,
          text: `Ivy, ${text}`,
        });
        f.utterance();
        await flush();
        f.update({
          assistant: {
            ...f.context().assistant,
            turn: 'admitted',
            turn_id: id,
          },
        });
        await vi.advanceTimersByTimeAsync(6000);
        expect(f.ports.speak).not.toHaveBeenCalled();
        expect(f.ports.submit).toHaveBeenCalledOnce();
      } finally {
        f.controller.dispose();
        vi.useRealTimers();
      }
    },
  );

  it('acknowledges only an admitted Terra voice turn and finishes the short cue before the final answer', async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      f.utterance();
      await flush();
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.ports.speak).not.toHaveBeenCalled();
      f.update({
        assistant: { ...f.context().assistant, turn: 'admitted', turn_id: id },
      });
      await vi.advanceTimersByTimeAsync(3000);
      expect(f.ports.speak.mock.calls[0][0]).toBe('One moment.');
      f.completed();
      await flush();
      expect(f.ports.speak).toHaveBeenCalledOnce();
      f.update({
        speech: {
          ...initialSpeechSnapshot(),
          revision: '2',
          operation_id: f.ports.speak.mock.calls[0][1],
        },
      });
      await flush();
      expect(f.ports.stop).not.toHaveBeenCalled();
      expect(f.ports.speak.mock.calls.map(([text]) => text)).toEqual([
        'One moment.',
        'A local reply',
      ]);
      f.completed();
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.ports.speak).toHaveBeenCalledTimes(2);
    } finally {
      f.controller.dispose();
      vi.useRealTimers();
    }
  });

  it('cancels a scheduled acknowledgment on mute and reset without replaying the request', async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      f.utterance();
      await flush();
      f.update({
        assistant: { ...f.context().assistant, turn: 'admitted', turn_id: id },
      });
      f.controller.setMuted(true);
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.ports.speak).not.toHaveBeenCalled();
      f.controller.setMuted(false);
      f.controller.stopVoice();
      f.completed();
      await flush();
      expect(f.ports.submit).toHaveBeenCalledOnce();
      expect(f.ports.speak).not.toHaveBeenCalled();
    } finally {
      f.controller.dispose();
      vi.useRealTimers();
    }
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
        text: 'Ivy, retained raw  ',
      });
      f.utterance();
      await flush();
      expect(state).toMatchObject({ raw: 'retained raw  ', status: 'error' });
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
      text: 'Ivy, ordinary request ',
    });
    f.utterance();
    await flush();
    expect(selectSession).toHaveBeenCalledExactlyOnceWith('terra');
    expect(f.ports.submit).toHaveBeenCalledExactlyOnceWith(
      'ordinary request',
      id,
    );
    expect(state.lastSubmittedRaw).toBe('ordinary request ');
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
      text: 'Ivy, ordinary request',
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
      "Alright, I'm done!",
      'alright im done',
      'All right, I’m done.',
      'alright i am done',
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
      'alright im done with this part',
      'explain alright im done',
      'Und dann',
      'I think.',
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
    await say('Ivy, prompt');
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
  it('runs a requested UI new session through lifecycle without submitting a model prompt', async () => {
    const newSession = vi.fn(async () => true),
      onNewSession = vi.fn();
    const f = fixture({ newSession, onNewSession });
    expect(await f.controller.newSession()).toBe(true);
    expect(newSession).toHaveBeenCalledOnce();
    expect(onNewSession).toHaveBeenCalledOnce();
    expect(f.ports.submit).not.toHaveBeenCalled();
    expect(f.view().passive).toBe(true);
    f.controller.dispose();
  });
  it('refuses a UI new session while an admitted turn is running', async () => {
    const newSession = vi.fn(async () => true);
    const f = fixture({ newSession });
    f.update({ assistant: { ...f.context().assistant, turn: 'admitted' } });
    expect(await f.controller.newSession()).toBe(false);
    expect(newSession).not.toHaveBeenCalled();
    expect(f.ports.submit).not.toHaveBeenCalled();
    f.controller.dispose();
  });
  it('accepts a standalone collected reload while passive without activating foreground presence', async () => {
    const reloadMcp = vi.fn(async () => true);
    const collect = vi.fn(async (_pcm: Int16Array, utterance_id: string) => ({
      version: 1,
      utterance_id,
      text: 'reload mcp',
    }));
    const f = fixture({ collect, reloadMcp });
    expect(f.view()).toMatchObject({ passive: true, foregroundActive: false });
    f.utterance();
    await flush();
    expect(reloadMcp).toHaveBeenCalledOnce();
    expect(f.view()).toMatchObject({
      passive: true,
      foregroundActive: false,
      notice: 'MCP integrations reloaded.',
    });
    expect(f.ports.submit).not.toHaveBeenCalled();
    f.controller.dispose();
  });

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
