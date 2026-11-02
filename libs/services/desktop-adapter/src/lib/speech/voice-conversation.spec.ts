import { describe, expect, it, vi } from 'vitest';
import type {
  SpeechTranscript,
  SpeechSnapshot,
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

const id = '11111111-2222-4333-8444-555555555555';
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
  const controller = new VoiceConversation({ ...ports, ...extra });
  controller.update(context);
  let sequence = 0;
  const update = (change: Partial<VoiceContext>) => {
    context = { ...context, ...change };
    controller.update(context);
  };
  const feed = (active: boolean, count: number) => {
    update({
      audio: {
        ...context.audio,
        activity: { ...context.audio.activity, active },
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
    ports,
    update,
    feed,
    utterance,
    completed,
    context: () => context,
    view: () => view,
  };
}

describe('voice conversation ownership', () => {
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
    for (const text of [
      'the prompt is clear',
      'say end prompt now',
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
