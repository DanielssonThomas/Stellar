import { describe, expect, it, vi } from 'vitest';
import { QuestionVoiceCue } from './question-voice-cue';
import { initialSpeechSnapshot } from './speech-transport';

describe('question voice cue', () => {
  it('ignores a late failure from an older cue', async () => {
    const state = initialSpeechSnapshot();
    let rejectOld: (reason: Error) => void = () => undefined;
    const old = new Promise<typeof state>((_, reject) => {
      rejectOld = reject;
    });
    const speak = vi
      .fn()
      .mockReturnValueOnce(old)
      .mockResolvedValue({ ...state, state: 'speaking', revision: '1' });
    const cue = new QuestionVoiceCue({
      enabled: () => true,
      state: () => state,
      speak,
      stop: async () => undefined,
    });
    cue.notify('old');
    cue.dispose();
    cue.notify('new');
    let finished = false;
    void cue.wait().then(() => {
      finished = true;
    });
    rejectOld(new Error('late'));
    await Promise.resolve();
    await Promise.resolve();
    expect(finished).toBe(false);
    cue.observe({ ...state, revision: '2' });
    await cue.wait();
  });
  function fixture(enabled = true) {
    const state = initialSpeechSnapshot();
    const speak = vi
      .fn()
      .mockResolvedValue({ ...state, state: 'speaking', revision: '1' });
    const stop = vi.fn().mockResolvedValue(undefined);
    return {
      state,
      speak,
      stop,
      cue: new QuestionVoiceCue({
        enabled: () => enabled,
        state: () => state,
        speak,
        stop,
      }),
    };
  }
  it('announces once and holds final narration until speech finishes', async () => {
    const { cue, speak, state } = fixture();
    cue.notify('q1');
    cue.notify('q1');
    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak.mock.calls[0][0]).toBe('Could you check this out?');
    let finished = false;
    void cue.wait().then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    cue.observe({ ...state, revision: '2' });
    await cue.wait();
    await Promise.resolve();
    expect(finished).toBe(true);
  });
  it('honors mute and does not interrupt existing speech', () => {
    const muted = fixture(false);
    muted.cue.notify('q1');
    expect(muted.speak).not.toHaveBeenCalled();
    const busy = fixture();
    busy.state.state = 'speaking';
    busy.cue.notify('q1');
    expect(busy.speak).not.toHaveBeenCalled();
  });
  it('stops its cue on cancellation and releases narration on epoch change', async () => {
    const { cue, stop, state } = fixture();
    cue.notify('q1');
    cue.cancel();
    await cue.wait();
    expect(stop).toHaveBeenCalledOnce();
    cue.notify('q2');
    cue.observe({ ...state, epoch: '2' });
    await cue.wait();
  });
});
