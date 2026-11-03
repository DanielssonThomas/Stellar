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
  it('never opens for short requests and shows only minimal working after five seconds', () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const timeline = new IvyActivityTimeline(publish);
    timeline.update(true, 'short', []);
    vi.advanceTimersByTime(1000);
    timeline.update(false, 'short', []);
    vi.advanceTimersByTime(6000);
    expect(publish.mock.lastCall?.[0].visible).toBe(false);
    timeline.update(true, 'long', []);
    vi.advanceTimersByTime(4999);
    expect(publish.mock.lastCall?.[0].visible).toBe(false);
    vi.advanceTimersByTime(1);
    expect(publish.mock.lastCall?.[0]).toMatchObject({
      visible: true,
      actions: [],
    });
    timeline.dispose();
    expect(vi.getTimerCount()).toBe(0);
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
