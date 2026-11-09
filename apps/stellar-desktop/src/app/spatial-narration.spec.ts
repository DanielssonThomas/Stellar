import { describe, expect, it, vi } from 'vitest';
import type { SpeechSnapshot } from '@stellar/desktop-contracts';
import type { SpatialSegment } from '@stellar/desktop-interaction';
import { SpatialNarration } from './spatial-narration';

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
  return { controller, apply, view, speak, stop, signal };
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

  it('lets the user advance when speech fails before playback', async () => {
    const f = fixture();
    f.speak.mockRejectedValueOnce(new Error('Unavailable'));
    f.controller.append([segment]);
    await tick();
    expect(f.view).toHaveBeenLastCalledWith('manual', '');
    expect(f.apply).not.toHaveBeenCalled();
    f.controller.next();
    expect(f.apply.mock.calls).toEqual([[segment.actions], [segment.after]]);
    expect(f.view).toHaveBeenLastCalledWith('idle', segment.text);
  });
});
