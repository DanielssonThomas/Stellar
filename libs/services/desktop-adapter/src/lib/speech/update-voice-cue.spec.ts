import { describe, expect, it, vi } from 'vitest';
import type { IvyBackgroundUpdate } from '@stellar/desktop-contracts';
import { initialSpeechSnapshot } from './speech-transport';
import { UpdateVoiceCue } from './update-voice-cue';
import { SpeechAdapterError } from './speech-adapter';

const update: IvyBackgroundUpdate = {
  id: 'admission',
  text: 'Your delegated task has finished.',
  speech_claim: null,
};

function fixture() {
  let busy = false,
    enabled = true,
    available = true;
  let state = initialSpeechSnapshot();
  const ports = {
    available: () => available,
    busy: () => busy,
    enabled: () => enabled,
    state: () => state,
    claim: vi.fn(async (_id: string, _request: string) => true),
    speak: vi.fn(
      async (_text: string, _id: string, _current: () => boolean) => ({
        ...state,
        revision: '1',
      }),
    ),
    stop: vi.fn(async () => undefined),
    waitForQuestion: vi.fn(async (): Promise<void> => undefined),
    id: () => crypto.randomUUID(),
    changed: vi.fn(),
    failed: vi.fn(),
  };
  return {
    ports,
    cue: new UpdateVoiceCue(ports),
    busy: (v: boolean) => (busy = v),
    enabled: (v: boolean) => (enabled = v),
    available: (v: boolean) => (available = v),
    state: (v: typeof state) => (state = v),
  };
}

describe('background update speech', () => {
  it('speaks once without microphone activity and suppresses replay', async () => {
    const f = fixture();
    f.cue.observe([update]);
    await vi.waitFor(() =>
      expect(f.ports.speak).toHaveBeenCalledExactlyOnceWith(
        update.text,
        expect.any(String),
        expect.any(Function),
      ),
    );
    f.cue.observe([update]);
    await Promise.resolve();
    expect(f.ports.claim).toHaveBeenCalledOnce();
    expect(f.ports.speak).toHaveBeenCalledOnce();
    f.cue.dispose();
  });

  it('honors persisted claims and muted output without replaying speech on unmute', async () => {
    const f = fixture();
    f.cue.observe([{ ...update, speech_claim: crypto.randomUUID() }]);
    expect(f.ports.claim).not.toHaveBeenCalled();
    f.enabled(false);
    f.cue.observe([update]);
    await vi.waitFor(() => expect(f.ports.claim).toHaveBeenCalledOnce());
    await Promise.resolve();
    f.enabled(true);
    f.cue.observe([update]);
    expect(f.ports.speak).not.toHaveBeenCalled();
    f.cue.dispose();
  });

  it('defers concurrent user turns and never blocks their speech while a claim is pending', async () => {
    const f = fixture();
    let claimed!: (value: boolean) => void;
    f.ports.claim.mockImplementation(
      () => new Promise((done) => (claimed = done)),
    );
    f.busy(true);
    f.cue.observe([update]);
    expect(f.ports.claim).not.toHaveBeenCalled();
    f.busy(false);
    f.cue.observe([update]);
    await vi.waitFor(() => expect(f.ports.claim).toHaveBeenCalledOnce());
    f.busy(true);
    claimed(true);
    await Promise.resolve();
    await f.cue.wait();
    expect(f.ports.speak).not.toHaveBeenCalled();
    f.busy(false);
    f.cue.observe([update]);
    await vi.waitFor(() => expect(f.ports.speak).toHaveBeenCalledOnce());
    f.cue.dispose();
  });

  it('cancels claims and in-flight dispatch before a late acknowledgement', async () => {
    for (const duringDispatch of [false, true]) {
      const f = fixture();
      let resolve!: () => void;
      if (duringDispatch)
        f.ports.speak.mockImplementation(
          () =>
            new Promise(
              (done) => (resolve = () => done(initialSpeechSnapshot())),
            ),
        );
      else
        f.ports.claim.mockImplementation(
          () => new Promise((done) => (resolve = () => done(true))),
        );
      f.cue.observe([update]);
      await vi.waitFor(() =>
        expect(
          duringDispatch ? f.ports.speak : f.ports.claim,
        ).toHaveBeenCalledOnce(),
      );
      f.cue.cancel();
      resolve();
      await vi.waitFor(() => expect(f.ports.changed).toHaveBeenCalled());
      expect(f.ports.speak).toHaveBeenCalledTimes(duringDispatch ? 1 : 0);
      expect(f.ports.stop).toHaveBeenCalledTimes(duringDispatch ? 1 : 0);
      f.cue.dispose();
    }
  });

  it('rechecks foreground work after the final question wait', async () => {
    const f = fixture();
    let resume!: () => void;
    f.ports.waitForQuestion
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(
        () => new Promise<void>((done) => (resume = done)),
      );
    f.cue.observe([update]);
    await vi.waitFor(() =>
      expect(f.ports.waitForQuestion).toHaveBeenCalledTimes(2),
    );
    f.busy(true);
    resume();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.ports.speak).not.toHaveBeenCalled();
    f.busy(false);
    f.cue.observe([update]);
    await vi.waitFor(() => expect(f.ports.speak).toHaveBeenCalledOnce());
    f.cue.dispose();
  });

  it('retains long updates as text and speaks a bounded notification', async () => {
    const f = fixture();
    f.cue.observe([{ ...update, text: 'Detailed result. '.repeat(400) }]);
    await vi.waitFor(() =>
      expect(f.ports.speak).toHaveBeenCalledExactlyOnceWith(
        "I have an update for you. It's available in the conversation.",
        expect.any(String),
        expect.any(Function),
      ),
    );
    f.cue.dispose();
  });

  it('invalidates a queued dispatch when its update is removed', async () => {
    const f = fixture();
    let current!: () => boolean;
    let operation = '';
    let finish!: () => void;
    f.ports.speak.mockImplementation((...args: unknown[]) => {
      current = args[2] as () => boolean;
      operation = args[1] as string;
      return new Promise(
        (done) => (finish = () => done(initialSpeechSnapshot())),
      );
    });
    f.cue.observe([update]);
    await vi.waitFor(() => expect(f.ports.speak).toHaveBeenCalledOnce());
    expect(current()).toBe(true);
    f.cue.observe([]);
    expect(current()).toBe(false);
    expect(f.ports.stop).toHaveBeenCalledWith(operation);
    finish();
    f.cue.dispose();
  });

  it('discards a late claim after reset without dispatching speech', async () => {
    const f = fixture();
    let claim!: (value: boolean) => void;
    f.ports.claim.mockImplementation(
      () => new Promise((done) => (claim = done)),
    );
    f.cue.observe([update]);
    await vi.waitFor(() => expect(f.ports.claim).toHaveBeenCalledOnce());
    f.cue.observe([]);
    claim(true);
    await vi.waitFor(() => expect(f.ports.changed).toHaveBeenCalled());
    expect(f.ports.speak).not.toHaveBeenCalled();
    f.cue.dispose();
  });

  it('reports uncertain claims without retrying or dispatching speech', async () => {
    const f = fixture();
    f.ports.claim.mockRejectedValue(new Error('uncertain acknowledgement'));
    f.cue.observe([update]);
    await vi.waitFor(() => expect(f.ports.failed).toHaveBeenCalledOnce());
    f.cue.observe([update]);
    expect(f.ports.claim).toHaveBeenCalledOnce();
    expect(f.ports.speak).not.toHaveBeenCalled();
    f.cue.dispose();
  });

  it('finishes when playback completion arrives before its acknowledgement', async () => {
    const f = fixture();
    f.state({ ...initialSpeechSnapshot(), revision: '3' });
    f.ports.speak.mockResolvedValue({
      ...initialSpeechSnapshot(),
      revision: '2',
      state: 'speaking',
      operation_id: crypto.randomUUID(),
    });
    f.cue.observe([update]);
    await vi.waitFor(() => expect(f.ports.changed).toHaveBeenCalled());
    await f.cue.wait();
    f.cue.dispose();
    expect(f.ports.stop).not.toHaveBeenCalled();
  });
  it.each(['claim', 'unavailable', 'timeout'] as const)(
    'retains a completed answer and correlates %s failure without replaying a consumed claim',
    async (mode) => {
      const f = fixture();
      let retained: IvyBackgroundUpdate = { ...update };
      f.ports.claim.mockImplementation(async (_id: string, request: string) => {
        retained = { ...retained, speech_claim: request };
        if (mode === 'claim') throw Error('PRIVATE raw claim error');
        return true;
      });
      if (mode === 'unavailable')
        f.state({
          ...initialSpeechSnapshot(),
          state: 'unavailable',
          error: 'unavailable',
        });
      if (mode === 'timeout')
        f.ports.speak.mockRejectedValue(
          new SpeechAdapterError('native', 'timeout'),
        );
      f.cue.observe([retained]);
      await vi.waitFor(() => expect(f.ports.failed).toHaveBeenCalledOnce());
      expect(f.ports.failed).toHaveBeenCalledWith(
        expect.objectContaining({
          admissionId: update.id,
          claimId: retained.speech_claim,
          stage:
            mode === 'claim'
              ? 'claim'
              : mode === 'unavailable'
                ? 'speech_ready'
                : 'speech_dispatch',
          code:
            mode === 'claim'
              ? 'failed'
              : mode === 'timeout'
                ? 'timeout'
                : 'unavailable',
          time: expect.stringMatching(/^\d{4}-/),
        }),
      );
      expect(retained.text).toBe(update.text);
      f.cue.observe([retained]);
      f.cue.observe([update]);
      await Promise.resolve();
      expect(f.ports.claim).toHaveBeenCalledOnce();
      expect(f.ports.speak).toHaveBeenCalledTimes(mode === 'timeout' ? 1 : 0);
      f.cue.dispose();
      const reopened = fixture();
      reopened.cue.observe([retained]);
      expect(reopened.ports.claim).not.toHaveBeenCalled();
      expect(reopened.ports.speak).not.toHaveBeenCalled();
      reopened.cue.dispose();
    },
  );
  it('keeps the stopped attempt IDs after a later attempt starts before stop rejects', async () => {
    const f = fixture();
    let finish!: () => void, rejectStop!: (reason: unknown) => void;
    f.ports.speak.mockImplementationOnce(
      () =>
        new Promise((done) => {
          finish = () => done(initialSpeechSnapshot());
        }),
    );
    f.ports.stop.mockImplementationOnce(
      () =>
        new Promise((_done, reject) => {
          rejectStop = reject;
        }),
    );
    f.cue.observe([update]);
    await vi.waitFor(() => expect(f.ports.speak).toHaveBeenCalledOnce());
    const oldClaim = f.ports.claim.mock.calls[0][1];
    const oldOperation = f.ports.speak.mock.calls[0][1];
    f.cue.cancel();
    finish();
    await vi.waitFor(() => expect(f.ports.changed).toHaveBeenCalled());
    f.cue.observe([{ ...update, id: 'later-admission' }]);
    await vi.waitFor(() => expect(f.ports.speak).toHaveBeenCalledTimes(2));
    rejectStop(Error('PRIVATE late stop failure'));
    await vi.waitFor(() => expect(f.ports.failed).toHaveBeenCalledOnce());
    expect(f.ports.failed).toHaveBeenCalledWith(
      expect.objectContaining({
        admissionId: update.id,
        claimId: oldClaim,
        operationId: oldOperation,
        stage: 'speech_stop',
        code: 'failed',
      }),
    );
    f.cue.dispose();
  });

  it('correlates an unavailable terminal speech observation without claiming audibility', async () => {
    const f = fixture();
    f.ports.speak.mockResolvedValue({
      ...initialSpeechSnapshot(),
      state: 'speaking',
      revision: '1',
    });
    f.cue.observe([update]);
    await vi.waitFor(() => expect(f.ports.speak).toHaveBeenCalledOnce());
    f.state({
      ...initialSpeechSnapshot(),
      state: 'unavailable',
      revision: '2',
      error: 'unavailable',
    });
    f.cue.observe([update]);
    await vi.waitFor(() => expect(f.ports.failed).toHaveBeenCalledOnce());
    expect(f.ports.failed).toHaveBeenCalledWith(
      expect.objectContaining({
        admissionId: update.id,
        operationId: f.ports.speak.mock.calls[0][1],
        stage: 'speech_completion',
        code: 'unavailable',
      }),
    );
    f.cue.dispose();
  });
});
