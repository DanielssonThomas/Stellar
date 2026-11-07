import { describe, expect, it, vi } from 'vitest';
import type {
  KeywordReply,
  SpeechSnapshot,
  SpeechTranscript,
} from '@stellar/desktop-contracts';
import type { ReflexOutcome } from '../reflex/reflex-controller';
import { initialIvySnapshot } from '../ivy/ivy-transport';
import { initialSpeechSnapshot } from './speech-transport';
import {
  VoiceConversation,
  type VoiceContext,
  type VoicePorts,
  type VoiceView,
} from './voice-conversation';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function settle() {
  for (let i = 0; i < 160; i++) await Promise.resolve();
}

function fixture(text: string, overrides: Partial<VoicePorts> = {}) {
  let sequence = 0,
    identity = 0,
    activations = 0;
  let view: VoiceView | undefined;
  let context: VoiceContext = {
    available: true,
    assistant: { ...initialIvySnapshot(), connection: 'ready' },
    speech: initialSpeechSnapshot(),
    audio: {
      status: 'capturing',
      activity: {
        active: false,
        starting: false,
        calibrating: false,
        level: 0.1,
        peakLevel: 0.1,
        durationMs: 0,
        noiseFloor: 0.001,
        clipped: false,
      },
    },
  };
  const collect = vi.fn(
    async (
      _pcm: Int16Array,
      utterance_id: string,
    ): Promise<SpeechTranscript> => ({ version: 1, utterance_id, text }),
  );
  const submit = vi.fn(async () => true);
  const observations = vi.fn();
  const transcribe = vi.fn(
    async (
      _pcm: Int16Array,
      utterance_id: string,
    ): Promise<SpeechTranscript> => ({
      version: 1,
      utterance_id,
      text: 'A post-wake request',
    }),
  );
  const controller = new VoiceConversation({
    keywords: async (_pcm, _stream, sequence): Promise<KeywordReply> => ({
      sequence,
      detection: null,
    }),
    collect,
    submit,
    transcribe,
    id: () => `fallback-${++identity}`,
    selectSession: async () => true,
    stop: async () => undefined,
    speak: async (_text, operation_id): Promise<SpeechSnapshot> => ({
      ...initialSpeechSnapshot(),
      operation_id,
    }),
    onRecognition: observations,
    onChange: (next) => {
      if (next.foregroundActive && !view?.foregroundActive) activations++;
      view = next;
    },
    ...overrides,
  });
  controller.update(context);
  const update = (change: Partial<VoiceContext>) => {
    context = { ...context, ...change };
    controller.update(context);
  };
  const feed = (active: boolean, count: number) => {
    update({
      audio: {
        ...context.audio,
        activity: { ...context.audio.activity, active, starting: active },
      },
    });
    for (let n = 0; n < count; n++) {
      const samples = new Int16Array(640).fill(active ? 2_000 : 0);
      controller.accept({
        type: 'chunk',
        chunk: { sequence: sequence++, sampleRate: 16000, samples },
      });
      expect(samples.every((sample) => sample === 0)).toBe(true);
    }
  };
  return {
    controller,
    collect,
    submit,
    transcribe,
    observations,
    update,
    context: () => context,
    view: () => {
      if (!view) throw new Error('Missing coordinator view');
      return view;
    },
    activations: () => activations,
    feed,
    utterance: () => {
      feed(true, 8);
      feed(false, 35);
    },
  };
}

describe('coordinator local transcript wake admission after KWS misses', () => {
  it.each([false, true])(
    'admits exact punctuated wake and keeps following words with overlay %s',
    async (visible) => {
      for (const wake of ['Ivy.', 'Hey Ivy.', 'I.V.', 'Ivy?!', 'I.V...']) {
        const f = fixture(`${wake} What time is it?`);
        f.controller.setRecognitionOptions('standard', visible);
        f.utterance();
        await settle();
        expect(f.submit).toHaveBeenCalledExactlyOnceWith(
          'What time is it?',
          expect.any(String),
        );
        expect(f.collect).toHaveBeenCalledOnce();
        expect(f.transcribe).not.toHaveBeenCalled();
        expect(f.activations()).toBe(1);
        if (visible)
          expect(f.observations).toHaveBeenCalledWith({
            text: `${wake} What time is it?`,
            status: 'Wake detected',
          });
        else expect(f.observations).not.toHaveBeenCalled();
        expect(f.collect.mock.calls[0][0].every((sample) => sample === 0)).toBe(
          true,
        );
        f.controller.dispose();
      }
    },
  );

  it.each(['I think', 'I mean', 'Heidi', 'IV', 'eerie', "I've"])(
    'admits %s only in High',
    async (alias) => {
      for (const sensitivity of ['standard', 'high'] as const) {
        const f = fixture(`${alias}, show the current issue`);
        f.controller.setRecognitionOptions(sensitivity, true);
        f.utterance();
        await settle();
        expect(f.submit).toHaveBeenCalledTimes(sensitivity === 'high' ? 1 : 0);
        expect(f.view().foregroundActive).toBe(sensitivity === 'high');
        expect(f.observations).toHaveBeenLastCalledWith({
          text: `${alias}, show the current issue`,
          status: sensitivity === 'high' ? 'Wake detected' : 'No wake detected',
        });
        f.controller.dispose();
      }
    },
  );

  it.each([
    'What time is it?',
    'Poison ivy is a plant',
    'They said Hey Ivy yesterday',
    'Ivybridge',
    'Heidiwood',
    'I thinkable',
    'clear',
    'new session',
    'prompt',
  ])('keeps non-wake %s local without activation', async (text) => {
    const f = fixture(text);
    f.controller.setRecognitionOptions('high', true);
    f.utterance();
    await settle();
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.activations()).toBe(0);
    expect(f.observations).toHaveBeenLastCalledWith({
      text,
      status: 'No wake detected',
    });
    f.controller.dispose();
  });

  it('activates a wake-only result without submitting it and retains the next request', async () => {
    const f = fixture('Ivy.');
    f.utterance();
    await settle();
    expect(f.view().foregroundActive).toBe(true);
    expect(f.submit).not.toHaveBeenCalled();
    f.collect.mockImplementationOnce(async (_pcm, utterance_id) => ({
      version: 1,
      utterance_id,
      text: 'What time is it?',
    }));
    f.utterance();
    await settle();
    expect(f.submit).toHaveBeenCalledExactlyOnceWith(
      'What time is it?',
      expect.any(String),
    );
    expect(f.activations()).toBe(1);
    f.controller.dispose();
  });

  it('a display toggle cannot cancel the independent fallback', async () => {
    const pending = deferred<SpeechTranscript>();
    const f = fixture('unused');
    f.collect.mockImplementationOnce(() => pending.promise);
    f.utterance();
    f.controller.setRecognitionOptions('standard', true);
    pending.resolve({
      version: 1,
      utterance_id: f.collect.mock.calls[0][1],
      text: 'Ivy, keep my request',
    });
    await settle();
    expect(f.submit).toHaveBeenCalledExactlyOnceWith(
      'keep my request',
      expect.any(String),
    );
    f.controller.dispose();
  });

  it('admits an exactly owned completed collect despite a lagging native collecting snapshot', async () => {
    const pending = deferred<SpeechTranscript>();
    const paused = vi.fn(async () => undefined);
    const f = fixture('unused', { waitForCapturePause: paused });
    f.collect.mockImplementationOnce(() => pending.promise);
    f.utterance();
    const id = f.collect.mock.calls[0][1];
    f.update({
      speech: {
        ...initialSpeechSnapshot(),
        operation_id: id,
        state: 'collecting',
      },
    });
    pending.resolve({
      version: 1,
      utterance_id: id,
      text: 'Ivy, read this issue',
    });
    await settle();
    expect(paused).toHaveBeenCalledOnce();
    expect(f.submit).toHaveBeenCalledExactlyOnceWith('read this issue', id);
    expect(f.view().error).toBe(false);
    f.controller.dispose();
  });

  it.each([
    'epoch',
    'workspace',
    'model',
    'reset',
    'session reset',
    'admitted turn',
    'unavailable',
    'dispose',
    'stop',
    'foreign collect',
    'playback',
    'sensitivity',
  ] as const)('fences a late result after %s changes', async (change) => {
    const pending = deferred<SpeechTranscript>();
    const f = fixture('unused');
    f.controller.setRecognitionOptions('high', true);
    f.collect.mockImplementationOnce(() => pending.promise);
    f.utterance();
    const id = f.collect.mock.calls[0][1];
    switch (change) {
      case 'epoch':
        f.update({ speech: { ...initialSpeechSnapshot(), epoch: '1' } });
        break;
      case 'workspace':
        f.update({
          assistant: { ...f.context().assistant, workspace_epoch: '1' },
        });
        break;
      case 'model':
        f.update({ assistant: { ...f.context().assistant, model: 'sol' } });
        break;
      case 'session reset':
        f.update({
          assistant: { ...f.context().assistant, reset_id: 'another-session' },
        });
        break;
      case 'admitted turn':
        f.update({
          assistant: {
            ...f.context().assistant,
            turn: 'admitted',
            turn_id: 'typed-turn',
          },
        });
        break;
      case 'reset':
        f.controller.accept({ type: 'reset' });
        break;
      case 'unavailable':
        f.controller.accept({ type: 'unavailable' });
        break;
      case 'dispose':
        f.controller.dispose();
        break;
      case 'stop':
        f.controller.stopVoice();
        break;
      case 'foreign collect':
        f.update({
          speech: {
            ...initialSpeechSnapshot(),
            state: 'collecting',
            operation_id: 'another-owner',
          },
        });
        break;
      case 'playback':
        f.update({
          speech: {
            ...initialSpeechSnapshot(),
            state: 'speaking',
            operation_id: 'another-owner',
          },
        });
        break;
      case 'sensitivity':
        f.controller.setRecognitionOptions('standard', true);
        break;
    }
    pending.resolve({
      version: 1,
      utterance_id: id,
      text: 'Ivy, must not send',
    });
    await settle();
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.activations()).toBe(0);
    expect(f.collect.mock.calls[0][0].every((sample) => sample === 0)).toBe(
      true,
    );
    f.controller.dispose();
  });

  it.each([
    'epoch',
    'workspace',
    'model',
    'busy',
    'foreign collect',
    'playback',
    'draft',
  ] as const)(
    'retires an admitted fallback when %s changes during capture handoff',
    async (change) => {
      const pause = deferred<void>();
      const stopped = vi.fn(async () => undefined);
      const f = fixture('Ivy, read my current pane', {
        waitForCapturePause: () => pause.promise,
        stop: stopped,
      });
      f.utterance();
      await settle();
      expect(f.submit).not.toHaveBeenCalled();
      expect(f.view().busy).toBe(true);
      if (change === 'epoch')
        f.update({ speech: { ...initialSpeechSnapshot(), epoch: '1' } });
      if (change === 'workspace')
        f.update({
          assistant: { ...f.context().assistant, workspace_epoch: '1' },
        });
      if (change === 'model')
        f.update({ assistant: { ...f.context().assistant, model: 'sol' } });
      if (change === 'busy')
        f.update({
          assistant: {
            ...f.context().assistant,
            turn: 'admitted',
            turn_id: 'another-turn',
          },
        });
      if (change === 'foreign collect' || change === 'playback')
        f.update({
          speech: {
            ...initialSpeechSnapshot(),
            operation_id: 'another-owner',
            state: change === 'playback' ? 'speaking' : 'collecting',
          },
        });
      if (change === 'draft') f.controller.setDraft('Retain my new draft');
      pause.resolve();
      await settle();
      expect(f.submit).not.toHaveBeenCalled();
      expect(stopped).not.toHaveBeenCalled();
      expect(f.view().busy).toBe(false);
      f.controller.dispose();
    },
  );

  it('retires a fallback while local routing is pending, before cloud handoff', async () => {
    const local = deferred<ReflexOutcome>();
    const reflex = vi.fn(() => local.promise);
    const f = fixture('Ivy, read my current pane', { reflex });
    f.utterance();
    await settle();
    expect(reflex).toHaveBeenCalledOnce();
    f.update({ assistant: { ...f.context().assistant, workspace_epoch: '1' } });
    local.resolve({ handled: false, reply: '', outcome: 'hermes' });
    await settle();
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.view().busy).toBe(false);
    f.controller.dispose();
  });

  it.each(['capture', 'Reflex'] as const)(
    'a sensitivity change fences High admission during the pending %s handoff',
    async (stage) => {
      for (const changed of [false, true]) {
        const pause = deferred<void>();
        const local = deferred<ReflexOutcome>();
        const reflex = vi.fn(() => local.promise);
        const f = fixture('Heidi, read my current pane', {
          waitForCapturePause: () =>
            stage === 'capture' ? pause.promise : Promise.resolve(),
          ...(stage === 'Reflex' ? { reflex } : {}),
        });
        f.controller.setRecognitionOptions('high', false);
        f.utterance();
        await settle();
        expect(f.submit).not.toHaveBeenCalled();
        expect(f.view().busy).toBe(true);
        if (stage === 'Reflex') expect(reflex).toHaveBeenCalledOnce();
        f.controller.setRecognitionOptions(changed ? 'standard' : 'high', true);
        pause.resolve();
        local.resolve({ handled: false, reply: '', outcome: 'hermes' });
        await settle();
        expect(f.submit).toHaveBeenCalledTimes(changed ? 0 : 1);
        if (changed) {
          expect(f.view().foregroundActive).toBe(false);
          expect(f.view().busy).toBe(false);
        } else {
          expect(f.submit).toHaveBeenCalledExactlyOnceWith(
            'read my current pane',
            expect.any(String),
          );
        }
        f.controller.dispose();
      }
    },
  );

  it('permits its own native Terra routing after the fallback handoff', async () => {
    const select = vi.fn(async () => {
      routed.update({
        assistant: {
          ...routed.context().assistant,
          model: 'terra',
          workspace_epoch: '1',
        },
      });
      return true;
    });
    const routed = fixture('IV. read my current pane', {
      selectSession: select,
    });
    routed.controller.setRecognitionOptions('high', false);
    routed.update({
      assistant: { ...routed.context().assistant, model: 'sol' },
    });
    routed.utterance();
    await settle();
    expect(select).toHaveBeenCalledExactlyOnceWith('terra');
    expect(routed.submit).toHaveBeenCalledExactlyOnceWith(
      'read my current pane',
      expect.any(String),
    );
    routed.controller.dispose();
  });

  it.each(['clear', 'done', 'reload mcp', 'new session'] as const)(
    'permits the native %s lifecycle operation to rotate its own workspace',
    async (command) => {
      const operation = vi.fn(async () => {
        f.update({
          assistant: {
            ...f.context().assistant,
            model: 'terra',
            workspace_epoch: '1',
          },
        });
        return true;
      });
      const f = fixture(`Ivy, ${command}`, {
        clearConversation: operation,
        reloadMcp: operation,
        newSession: operation,
      });
      f.update({ assistant: { ...f.context().assistant, model: 'sol' } });
      f.utterance();
      await settle();
      expect(operation).toHaveBeenCalledOnce();
      expect(f.submit).not.toHaveBeenCalled();
      expect(f.view().error).toBe(false);
      expect(f.view().busy).toBe(false);
      if (command === 'reload mcp')
        expect(f.view().notice).toBe('MCP integrations reloaded.');
      f.controller.dispose();
    },
  );

  it('typed capture ownership suppresses fallback and releases without a collect self-deadlock', async () => {
    const pending = deferred<SpeechTranscript>();
    const f = fixture('unused');
    f.collect.mockImplementationOnce(() => pending.promise);
    f.utterance();
    const id = f.collect.mock.calls[0][1];
    const action = vi.fn(async () => false);
    const typed = f.controller.withCaptureReleased(action);
    pending.resolve({
      version: 1,
      utterance_id: id,
      text: 'Ivy, must not send',
    });
    await settle();
    expect(await typed).toBe(false);
    expect(action).toHaveBeenCalledOnce();
    expect(f.submit).not.toHaveBeenCalled();
    f.controller.dispose();
  });

  it('preserves an active draft when a passive fallback finishes late', async () => {
    const pending = deferred<SpeechTranscript>();
    const composition = vi.fn();
    const f = fixture('unused', { onComposition: composition });
    f.collect.mockImplementationOnce(() => pending.promise);
    f.utterance();
    const id = f.collect.mock.calls[0][1];
    f.controller.setDraft('Keep my draft unchanged');
    pending.resolve({
      version: 1,
      utterance_id: id,
      text: 'Ivy, replace this',
    });
    await settle();
    expect(f.submit).not.toHaveBeenCalled();
    expect(composition.mock.lastCall?.[0]).toMatchObject({
      status: 'composing',
      raw: 'Keep my draft unchanged',
      draft: 'Keep my draft unchanged',
    });
    expect(f.observations).not.toHaveBeenCalled();
    f.controller.dispose();
  });

  it('fallback wins a delayed KWS result without duplicate activation or submission', async () => {
    const keyword = deferred<KeywordReply>();
    const f = fixture('Ivy, retain this whole request', {
      keywords: () => keyword.promise,
    });
    f.utterance();
    await settle();
    expect(f.submit).toHaveBeenCalledOnce();
    keyword.resolve({
      sequence: 0,
      detection: { command: 'ivy', end_sample: 640 },
    });
    await settle();
    expect(f.submit).toHaveBeenCalledOnce();
    expect(f.activations()).toBe(1);
    expect(f.transcribe).not.toHaveBeenCalled();
    f.controller.dispose();
  });

  it('KWS wins a pending fallback and serializes the retained post-wake request', async () => {
    let wakeNext = false,
      active = false,
      collisions = 0;
    const pending = deferred<SpeechTranscript>();
    const collect = vi.fn(async (_pcm: Int16Array, utterance_id: string) => {
      if (active) collisions++;
      active = true;
      try {
        return collect.mock.calls.length === 1
          ? await pending.promise
          : { version: 1, utterance_id, text: 'Retained post-wake body' };
      } finally {
        active = false;
      }
    });
    const f = fixture('unused', {
      collect,
      keywords: async (_pcm, _stream, sequence) => {
        const detection = wakeNext
          ? { command: 'ivy' as const, end_sample: (sequence + 1) * 640 }
          : null;
        wakeNext = false;
        return { sequence, detection };
      },
    });
    f.utterance();
    await settle();
    wakeNext = true;
    f.feed(true, 1);
    await settle();
    f.utterance();
    await settle();
    expect(collect).toHaveBeenCalledOnce();
    pending.resolve({
      version: 1,
      utterance_id: collect.mock.calls[0][1],
      text: 'Ivy, obsolete fallback body',
    });
    await settle();
    expect(collisions).toBe(0);
    expect(f.submit).toHaveBeenCalledExactlyOnceWith(
      'Retained post-wake body',
      expect.any(String),
    );
    expect(f.activations()).toBe(1);
    f.controller.dispose();
  });

  it('a capped passive phrase cannot admit a prefix from its short-pause continuation', async () => {
    const f = fixture('Ivy, an invalid capped continuation');
    for (let n = 0; n < 510; n++) {
      f.feed(true, 1);
      await settle();
    }
    f.feed(false, 1);
    f.feed(true, 8);
    f.feed(false, 15);
    await settle();
    expect(f.collect).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
    f.feed(false, 25);
    await settle();
    f.utterance();
    await settle();
    expect(f.collect).toHaveBeenCalledOnce();
    expect(f.submit).toHaveBeenCalledOnce();
    f.controller.dispose();
  });
});
