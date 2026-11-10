import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SpeechSnapshot } from '@stellar/desktop-contracts';
import type { SpatialSegment } from './spatial-presentation';
import { readingTime, SpatialNarration } from './spatial-narration';

afterEach(() => vi.useRealTimers());

const segment: SpatialSegment = {
  text: 'Look at the research.',
  actions: [{ kind: 'focus', id: 'research' }],
  after: [{ kind: 'overview' }],
};
const next: SpatialSegment = {
  text: 'Consider the evidence.',
  actions: [{ kind: 'expand', id: 'research' }],
};
const tick = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};
function fixture() {
  let snapshot: SpeechSnapshot = {
    version: 1,
    epoch: '1',
    revision: '0',
    operation_id: null,
    state: 'idle',
    error: null,
  };
  let revision = 0;
  let index = 0;
  const apply = vi.fn();
  const view = vi.fn();
  const record = vi.fn();
  const stop = vi.fn(async () => undefined);
  const speak = vi.fn(
    async (_text: string, id: string): Promise<SpeechSnapshot> => {
      snapshot = {
        ...snapshot,
        revision: String(++revision),
        operation_id: id,
        state: 'synthesizing',
      };
      return snapshot;
    },
  );
  const controller = new SpatialNarration({
    initialize: async () => undefined,
    read: () => snapshot,
    id: () => String(++index),
    speak,
    stop,
    apply,
    record,
    view,
  });
  function signal(state: SpeechSnapshot['state'], id: string | null) {
    snapshot = {
      ...snapshot,
      state,
      operation_id: id,
      revision: String(++revision),
    };
    controller.observe(snapshot);
  }
  return { controller, apply, view, speak, stop, signal, record };
}

describe('spatial narration', () => {
  it('cues at matching playback boundaries and accepts a segment while speech is active', async () => {
    const f = fixture();
    f.controller.append([segment]);
    await tick();
    expect(f.apply).not.toHaveBeenCalled();
    f.signal('speaking', '1');
    f.signal('speaking', '1');
    f.controller.append([next]);
    expect(f.apply).toHaveBeenCalledTimes(1);
    expect(f.apply).toHaveBeenLastCalledWith(segment.actions);
    expect(f.speak).toHaveBeenCalledTimes(1);
    f.signal('idle', null);
    await tick();
    expect(f.apply).toHaveBeenLastCalledWith(segment.after);
    expect(f.speak).toHaveBeenLastCalledWith(next.text, '2');
    f.signal('speaking', '2');
    expect(f.apply).toHaveBeenLastCalledWith(next.actions);
  });

  it('drops queued cues and ignores playback that arrives after interruption', async () => {
    const f = fixture();
    f.controller.append([segment, next]);
    await tick();
    f.controller.cancel();
    f.signal('speaking', '1');
    f.signal('idle', null);
    await tick();
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.stop).toHaveBeenCalledOnce();
    expect(f.speak).toHaveBeenCalledOnce();
    expect(f.view).toHaveBeenLastCalledWith('idle', '');
  });

  it.each([
    { state: 'idle', stops: 1 },
    { state: 'speaking', stops: 0 },
  ] as const)(
    'cancels pending speech only when the other operation is idle ($state)',
    async ({ state, stops }) => {
      const f = fixture();
      f.signal('idle', 'previous');
      f.speak.mockImplementationOnce(() => new Promise(() => undefined));
      f.controller.append([segment]);
      await tick();
      expect(f.speak).toHaveBeenCalledOnce();
      f.signal(state, 'previous');

      f.controller.cancel();

      expect(f.stop).toHaveBeenCalledTimes(stops);
      expect(f.apply).not.toHaveBeenCalled();
      expect(f.view).toHaveBeenLastCalledWith('idle', '');
    },
  );

  it('advances without input when audio fails and gives longer text more time', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const long = {
      ...next,
      text: 'Longer supporting details take time to read. '.repeat(8),
    };
    f.speak.mockRejectedValueOnce(new Error('Unavailable'));
    f.controller.append([segment, long]);
    await tick();
    expect(f.view).toHaveBeenLastCalledWith('reading', segment.text);
    expect(f.apply.mock.calls).toEqual([[segment.actions]]);
    vi.advanceTimersByTime(readingTime(segment.text));
    expect(f.apply.mock.calls).toEqual([
      [segment.actions],
      [segment.after],
      [long.actions],
    ]);
    vi.advanceTimersByTime(readingTime(segment.text));
    expect(f.view).toHaveBeenLastCalledWith('reading', long.text);
    vi.advanceTimersByTime(readingTime(long.text) - readingTime(segment.text));
    expect(f.view).toHaveBeenLastCalledWith('idle', long.text);
    expect(f.record.mock.calls).toEqual([[segment.text], [long.text]]);
    expect(f.speak).toHaveBeenCalledOnce();
  });

  it('pauses, steps, resumes and cancels the read-along clock', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const f = fixture();
    f.speak.mockRejectedValueOnce(new Error('Unavailable'));
    f.controller.append([segment, next, segment]);
    await tick();
    vi.advanceTimersByTime(500);
    f.controller.toggleReadAlong();
    vi.advanceTimersByTime(30000);
    expect(f.view).toHaveBeenLastCalledWith('paused', segment.text);
    expect(f.apply).toHaveBeenCalledOnce();
    f.controller.next();
    expect(f.view).toHaveBeenLastCalledWith('paused', next.text);
    expect(f.apply).toHaveBeenLastCalledWith(next.actions);
    f.controller.toggleReadAlong();
    vi.advanceTimersByTime(readingTime(next.text));
    expect(f.view).toHaveBeenLastCalledWith('reading', segment.text);
    f.controller.cancel();
    const applied = f.apply.mock.calls.length;
    vi.runAllTimers();
    expect(f.apply).toHaveBeenCalledTimes(applied);
    expect(f.view).toHaveBeenLastCalledWith('idle', '');
  });
});
