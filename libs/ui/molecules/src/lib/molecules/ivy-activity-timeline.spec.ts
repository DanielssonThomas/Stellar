import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  IvyActivityTimeline,
  type IvyActivityItem,
} from './ivy-activity-timeline';
const row: IvyActivityItem = {
  id: '1',
  label: 'Shell command',
  status: 'running',
  running: true,
  confirmed: false,
  indicator: null,
};
afterEach(() => vi.useRealTimers());
describe('Ivy activity timing', () => {
  it('opens immediately on accepted requests without inventing tool activity', () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const timeline = new IvyActivityTimeline(publish);
    timeline.update(true, 'short', []);
    expect(publish.mock.lastCall?.[0]).toMatchObject({
      visible: true,
      actions: [],
    });
    vi.advanceTimersByTime(1000);
    timeline.update(false, 'short', []);
    vi.advanceTimersByTime(6000);
    expect(publish.mock.lastCall?.[0].visible).toBe(false);
    timeline.update(true, 'long', []);
    expect(publish.mock.lastCall?.[0]).toMatchObject({
      visible: true,
      actions: [],
    });
    timeline.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('measures observed action elapsed time and freezes completed rows', () => {
    vi.useFakeTimers();
    let now = 100;
    const publish = vi.fn();
    const timeline = new IvyActivityTimeline(publish, () => now);
    timeline.update(true, 'turn', [row]);
    now = 2100;
    vi.advanceTimersByTime(1000);
    expect(publish.mock.lastCall?.[0].actions[0].elapsedMs).toBe(2000);
    timeline.update(true, 'turn', [{ ...row, running: false }]);
    now = 5100;
    vi.advanceTimersByTime(1000);
    expect(publish.mock.lastCall?.[0].actions[0].elapsedMs).toBe(2000);
    timeline.update(true, 'new', [row]);
    expect(publish.mock.lastCall?.[0].actions[0].elapsedMs).toBe(0);
    timeline.dispose();
  });
  it('opens on real tools, bounds rows and avoids flicker between adjacent turns', () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const timeline = new IvyActivityTimeline(publish);
    timeline.update(
      true,
      'a',
      Array.from({ length: 50 }, (_, i) => ({ ...row, id: String(i) })),
    );
    expect(publish.mock.lastCall?.[0].actions).toHaveLength(12);
    timeline.update(false, 'a', []);
    expect(publish.mock.lastCall?.[0].leaving).toBe(true);
    vi.advanceTimersByTime(100);
    timeline.update(true, 'b', [row]);
    vi.advanceTimersByTime(300);
    expect(publish.mock.lastCall?.[0]).toMatchObject({
      visible: true,
      leaving: false,
    });
    timeline.update(false, null, []);
    vi.advanceTimersByTime(240);
    expect(publish.mock.lastCall?.[0]).toMatchObject({
      visible: false,
      actions: [],
    });
    timeline.dispose();
  });
});
