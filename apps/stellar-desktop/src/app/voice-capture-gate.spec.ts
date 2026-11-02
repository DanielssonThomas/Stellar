import { describe, expect, it, vi } from 'vitest';
import { VoiceCaptureGate, type CaptureIdentity } from './voice-capture-gate';
import {
  VoiceConversation,
  initialIvySnapshot,
  initialSpeechSnapshot,
  type VoiceContext,
} from '@stellar/service-desktop-adapter';

function deferred() {
  let resolve!: () => void;
  return {
    promise: new Promise<void>((done) => {
      resolve = done;
    }),
    resolve,
  };
}

function fixture() {
  let state: CaptureIdentity = {
    requestId: 7,
    deviceId: 'device-1',
    available: true,
    status: 'capturing',
  };
  const releaseDone = deferred();
  const release = vi.fn(() => {
    state = { ...state, status: 'turn-paused' };
    return releaseDone.promise;
  });
  const acquire = vi.fn(async (device?: string): Promise<void> => {
    void device;
  });
  const failed = vi.fn();
  const gate = new VoiceCaptureGate(() => state, release, acquire, failed);
  return {
    gate,
    failed,
    release,
    acquire,
    releaseDone,
    update: (change: Partial<CaptureIdentity>) => {
      state = { ...state, ...change };
    },
  };
}

async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe('voice capture release gate', () => {
  it('does not send through a lease after microphone identity changes', async () => {
    const f = fixture();
    const send = vi.fn(async () => true);
    const voice = new VoiceConversation({
      transcribe: async (_pcm, utterance_id) => ({
        version: 1,
        utterance_id,
        text: '',
      }),
      submit: async () => true,
      speak: async () => initialSpeechSnapshot(),
      stop: async () => undefined,
      id: () => 'unused',
      onChange: () => undefined,
      onCapturePauseChange: (paused) => f.gate.setPaused(paused),
      waitForCapturePause: () => f.gate.waitForRelease(),
    });
    voice.update({
      available: true,
      audio: {
        status: 'capturing',
        activity: {
          calibrating: false,
          active: false,
          level: 0,
          peakLevel: 0,
          durationMs: 0,
          noiseFloor: 0,
          clipped: false,
        },
      },
      assistant: { ...initialIvySnapshot(), connection: 'ready' },
      speech: initialSpeechSnapshot(),
    });
    const pending = voice.withCaptureReleased(send);
    f.update({ requestId: 8, deviceId: 'device-2', status: 'requesting' });
    f.gate.refresh();
    f.update({ requestId: 9, status: 'idle' });
    f.releaseDone.resolve();
    expect(await pending).toBe(false);
    expect(send).not.toHaveBeenCalled();
    await flush();
    expect(f.acquire).not.toHaveBeenCalled();
    voice.dispose();
  });
  it('rejects a typed release lease if the requested input changes before release', async () => {
    const f = fixture();
    f.gate.setPaused(true);
    const pending = f.gate.waitForRelease();
    f.update({ requestId: 8, deviceId: 'device-2', status: 'requesting' });
    f.gate.refresh();
    f.releaseDone.resolve();
    await expect(pending).rejects.toThrow('Capture release no longer applies');
    f.gate.setPaused(false);
    f.update({ requestId: 9, deviceId: 'device-3', status: 'idle' });
    await flush();
    expect(f.acquire).not.toHaveBeenCalled();
  });

  it('propagates an actual source release failure', async () => {
    const f = fixture();
    f.release.mockImplementationOnce(() =>
      Promise.reject(new Error('release failed')),
    );
    f.gate.setPaused(true);
    await expect(f.gate.waitForRelease()).rejects.toThrow('release failed');
  });
  it('releases for an external Ivy turn and reacquires the same device after completion', async () => {
    const f = fixture();
    let draft = '';
    const transcribe = vi.fn();
    const voice = new VoiceConversation({
      transcribe,
      submit: async () => true,
      speak: async () => initialSpeechSnapshot(),
      stop: async () => undefined,
      id: () => 'unused',
      onChange: () => undefined,
      onCapturePauseChange: (paused) => f.gate.setPaused(paused),
      onComposition: (state) => {
        draft = state.raw;
      },
    });
    const context: VoiceContext = {
      available: true,
      audio: {
        status: 'capturing',
        activity: {
          calibrating: false,
          active: false,
          level: 0,
          peakLevel: 0,
          durationMs: 0,
          noiseFloor: 0,
          clipped: false,
        },
      },
      assistant: { ...initialIvySnapshot(), connection: 'ready' },
      speech: initialSpeechSnapshot(),
    };
    voice.update(context);
    voice.setDraft('keep this');
    voice.update({
      ...context,
      assistant: { ...context.assistant, turn: 'admitted' },
    });
    expect(f.release).toHaveBeenCalledOnce();
    voice.accept({ type: 'turn-pause' });
    voice.update({
      ...context,
      audio: { ...context.audio, status: 'turn-paused' },
      assistant: { ...context.assistant, turn: 'completed' },
    });
    expect(f.acquire).not.toHaveBeenCalled();
    f.releaseDone.resolve();
    await flush();
    expect(f.acquire).toHaveBeenCalledExactlyOnceWith('device-1');
    expect(transcribe).not.toHaveBeenCalled();
    expect(draft).toBe('keep this');
    voice.dispose();
  });
  it('releases once and reacquires the original device once only after release settles', async () => {
    const f = fixture();
    f.gate.setPaused(true);
    f.gate.setPaused(true);
    f.gate.setPaused(false);
    f.gate.setPaused(false);
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.acquire).not.toHaveBeenCalled();
    f.releaseDone.resolve();
    await flush();
    expect(f.acquire).toHaveBeenCalledExactlyOnceWith('device-1');
  });
  it.each([
    { requestId: null },
    { requestId: 8 },
    { deviceId: 'device-2' },
    { available: false },
    { status: 'idle' },
    { status: 'denied' },
  ])(
    'never reacquires after authorization or capture identity changes: %o',
    async (change) => {
      const f = fixture();
      f.gate.setPaused(true);
      f.gate.setPaused(false);
      f.update(change);
      f.releaseDone.resolve();
      await flush();
      expect(f.acquire).not.toHaveBeenCalled();
    },
  );
  it('rejects a stalled physical release rather than starting recognition', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      f.gate.setPaused(true);
      const result = f.gate.waitForRelease();
      const rejected = expect(result).rejects.toThrow(
        'Capture release timed out',
      );
      await vi.advanceTimersByTimeAsync(5000);
      await rejected;
      expect(f.failed).toHaveBeenCalledOnce();
      expect(f.acquire).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('isolates a timed-out release after an explicit new capture request', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      f.gate.setPaused(true);
      const oldWait = expect(f.gate.waitForRelease()).rejects.toThrow(
        'Capture release timed out',
      );
      await vi.advanceTimersByTimeAsync(5000);
      await oldWait;
      f.gate.setPaused(false);
      f.update({ requestId: null, status: 'idle' });
      f.update({ requestId: 8, status: 'capturing' });
      f.release.mockImplementationOnce(() => {
        f.update({ status: 'turn-paused' });
        return Promise.resolve();
      });
      f.gate.setPaused(true);
      const transcribe = vi.fn();
      const ready = f.gate.waitForRelease().then(transcribe);
      await flush();
      expect(transcribe).toHaveBeenCalledOnce();
      await ready;
      f.gate.setPaused(false);
      await flush();
      expect(f.acquire).toHaveBeenCalledExactlyOnceWith('device-1');
      f.releaseDone.resolve();
      await flush();
      expect(f.acquire).toHaveBeenCalledOnce();
      expect(f.failed).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('transcribes a new utterance and reacquires after an earlier release timed out', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      f.gate.setPaused(true);
      const oldWait = expect(f.gate.waitForRelease()).rejects.toThrow(
        'Capture release timed out',
      );
      await vi.advanceTimersByTimeAsync(5000);
      await oldWait;
      f.gate.setPaused(false);
      f.update({ requestId: null, status: 'idle' });
      f.update({ requestId: 8, status: 'capturing' });
      f.release.mockImplementationOnce(() => {
        f.update({ status: 'turn-paused' });
        return Promise.resolve();
      });
      const transcribe = vi.fn(
        async (_pcm: Int16Array, utterance_id: string) => ({
          version: 1 as const,
          utterance_id,
          text: '',
        }),
      );
      const voice = new VoiceConversation({
        transcribe,
        submit: async () => true,
        speak: async () => initialSpeechSnapshot(),
        stop: async () => undefined,
        id: () => 'test-utterance',
        onChange: () => undefined,
        onCapturePauseChange: (paused) => f.gate.setPaused(paused),
        waitForCapturePause: () => f.gate.waitForRelease(),
      });
      const context: VoiceContext = {
        available: true,
        audio: {
          status: 'capturing',
          activity: {
            calibrating: false,
            active: false,
            level: 0,
            peakLevel: 0,
            durationMs: 0,
            noiseFloor: 0,
            clipped: false,
          },
        },
        assistant: { ...initialIvySnapshot(), connection: 'ready' },
        speech: initialSpeechSnapshot(),
      };
      let sequence = 0;
      for (const [active, count] of [
        [true, 5],
        [false, 35],
      ] as const) {
        voice.update({
          ...context,
          audio: {
            ...context.audio,
            activity: { ...context.audio.activity, active },
          },
        });
        for (let i = 0; i < count; i++)
          voice.accept({
            type: 'chunk',
            chunk: {
              sampleRate: 16000,
              sequence: sequence++,
              samples: new Int16Array(640).fill(active ? 2000 : 0),
            },
          });
      }
      await flush();
      expect(transcribe).toHaveBeenCalledOnce();
      expect(f.acquire).toHaveBeenCalledExactlyOnceWith('device-1');
      f.releaseDone.resolve();
      await flush();
      expect(f.acquire).toHaveBeenCalledOnce();
      voice.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never automatically resumes the same capture after a release timeout', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      f.gate.setPaused(true);
      const oldWait = expect(f.gate.waitForRelease()).rejects.toThrow(
        'Capture release timed out',
      );
      await vi.advanceTimersByTimeAsync(5000);
      await oldWait;
      f.gate.setPaused(false);
      f.releaseDone.resolve();
      await flush();
      expect(f.acquire).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not report an expired older wait against a replacement request', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      f.gate.setPaused(true);
      const oldWait = expect(f.gate.waitForRelease()).rejects.toThrow(
        'Capture release timed out',
      );
      f.update({ requestId: 8, status: 'requesting' });
      f.release.mockImplementationOnce(() => {
        f.update({ status: 'turn-paused' });
        return Promise.resolve();
      });
      f.gate.refresh();
      await vi.advanceTimersByTimeAsync(5000);
      await oldWait;
      expect(f.failed).not.toHaveBeenCalled();
      f.releaseDone.resolve();
      await expect(f.gate.waitForRelease()).resolves.toBeUndefined();
      f.gate.setPaused(false);
      await flush();
      expect(f.acquire).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports failed reacquisition without retrying', async () => {
    const f = fixture();
    f.acquire.mockRejectedValueOnce(new Error('unavailable'));
    f.gate.setPaused(true);
    f.gate.setPaused(false);
    f.releaseDone.resolve();
    await flush();
    expect(f.acquire).toHaveBeenCalledOnce();
    expect(f.failed).toHaveBeenCalledOnce();
  });

  it.each([{ requestId: 8 }, { status: 'capturing' }])(
    'does not report an old acquisition failure against a replacement: %o',
    async (change) => {
      const f = fixture();
      let reject!: (reason: Error) => void;
      f.acquire.mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, fail) => {
            reject = fail;
          }),
      );
      f.gate.setPaused(true);
      f.gate.setPaused(false);
      f.releaseDone.resolve();
      await flush();
      f.update(change);
      reject(new Error('old failure'));
      await flush();
      expect(f.failed).not.toHaveBeenCalled();
    },
  );

  it('coalesces an interrupted resume and reacquires only after the later turn settles', async () => {
    const f = fixture();
    f.gate.setPaused(true);
    f.gate.setPaused(false);
    f.gate.setPaused(true);
    f.releaseDone.resolve();
    await flush();
    expect(f.acquire).not.toHaveBeenCalled();
    f.gate.setPaused(false);
    await flush();
    expect(f.acquire).toHaveBeenCalledExactlyOnceWith('device-1');
  });

  it('releases a newly requesting capture while the turn remains paused', async () => {
    const f = fixture();
    f.gate.setPaused(true);
    f.update({ requestId: 8, deviceId: 'device-2', status: 'requesting' });
    f.gate.refresh();
    expect(f.release).toHaveBeenCalledTimes(2);
    f.gate.setPaused(false);
    f.releaseDone.resolve();
    await flush();
    expect(f.acquire).toHaveBeenCalledExactlyOnceWith('device-2');
  });

  it('fences reacquisition after disposal or a new pause', async () => {
    const f = fixture();
    f.gate.setPaused(true);
    f.gate.setPaused(false);
    f.gate.setPaused(true);
    f.gate.dispose();
    f.releaseDone.resolve();
    await flush();
    expect(f.acquire).not.toHaveBeenCalled();
  });
});
