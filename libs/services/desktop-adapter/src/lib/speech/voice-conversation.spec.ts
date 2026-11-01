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
} from './voice-conversation';

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

function fixture() {
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
  const controller = new VoiceConversation(ports);
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
