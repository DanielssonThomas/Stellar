import { describe, expect, it, vi } from 'vitest';
import type { IvyBackgroundUpdate } from '@stellar/desktop-contracts';
import { initialSpeechSnapshot } from './speech-transport';
import { UpdateVoiceCue } from './update-voice-cue';

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
    claim: vi.fn(async () => true),
    speak: vi.fn(async () => ({ ...state, revision: '1' })),
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
});
