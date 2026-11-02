import { describe, expect, it, vi } from 'vitest';
import { VoiceCaptureGate, type CaptureIdentity } from './voice-capture-gate';

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
