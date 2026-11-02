import { describe, expect, it } from 'vitest';
import { directStage, StageRect } from './stage-director';

const instances = Array.from({ length: 4 }, (_, index) => ({
  instanceId: `item-${index}`,
  prominence: index === 0 ? ('primary' as const) : ('secondary' as const),
  minimized: false,
}));
const overlaps = (a: StageRect, b: StageRect) =>
  a.x < b.x + b.width &&
  a.x + a.width > b.x &&
  a.y < b.y + b.height &&
  a.y + a.height > b.y;

describe('Stage director', () => {
  it('honors controller targets without panes and docks whenever a workspace is visible', () => {
    const viewport = { width: 1000, height: 800 };
    const dock = directStage(viewport, [], 'docked');
    expect(dock.emblem).toEqual({ x: 886, y: 686, width: 90, height: 90 });
    const focused = directStage(viewport, instances, 'focused');
    expect(focused.emblem).toEqual(dock.emblem);
    expect(directStage(viewport, [], 'center').emblem.width).toBe(480);
  });
  it.each([
    { width: 1440, height: 900 },
    { width: 320, height: 600 },
    { width: 80, height: 80 },
    { width: 0, height: 0 },
  ])(
    'keeps independent surfaces and emblem inside resized bounds %o',
    (viewport) => {
      const layout = directStage(viewport, instances);
      const rects = layout.surfaces;
      for (const rect of rects) {
        expect(rect.x).toBeGreaterThanOrEqual(0);
        expect(rect.y).toBeGreaterThanOrEqual(0);
        expect(rect.width).toBeGreaterThanOrEqual(0);
        expect(rect.height).toBeGreaterThanOrEqual(0);
        expect(rect.x + rect.width).toBeLessThanOrEqual(viewport.width + 0.001);
        expect(rect.y + rect.height).toBeLessThanOrEqual(
          viewport.height + 0.001,
        );
      }
      for (let index = 0; index < rects.length; index++)
        for (let next = index + 1; next < rects.length; next++)
          expect(overlaps(rects[index], rects[next])).toBe(false);
    },
  );

  it.each([1, 2, 3, 4])(
    'partitions the complete viewport for %i panes with a single shared edge',
    (count) => {
      for (const viewport of [
        { width: 2048, height: 1095 },
        { width: 900, height: 700 },
        { width: 480, height: 600 },
      ]) {
        const panes = directStage(viewport, instances.slice(0, count)).surfaces;
        const area = panes.reduce(
          (total, pane) => total + pane.width * pane.height,
          0,
        );
        expect(area).toBeCloseTo(viewport.width * viewport.height, 6);
        expect(Math.min(...panes.map((pane) => pane.x))).toBe(0);
        expect(Math.min(...panes.map((pane) => pane.y))).toBe(0);
        expect(Math.max(...panes.map((pane) => pane.x + pane.width))).toBe(
          viewport.width,
        );
        expect(Math.max(...panes.map((pane) => pane.y + pane.height))).toBe(
          viewport.height,
        );
        for (let i = 0; i < panes.length; i++)
          for (let j = i + 1; j < panes.length; j++)
            expect(overlaps(panes[i], panes[j])).toBe(false);
      }
    },
  );

  it('uses a full-height primary with supporting panes and preserves input order', () => {
    const panes = directStage(
      { width: 1600, height: 1000 },
      instances.slice(0, 3),
    ).surfaces;
    expect(panes).toEqual([
      { instanceId: 'item-0', x: 0, y: 0, width: 864, height: 1000 },
      { instanceId: 'item-1', x: 864, y: 0, width: 736, height: 500 },
      { instanceId: 'item-2', x: 864, y: 500, width: 736, height: 500 },
    ]);
    expect(instances.map((item) => item.instanceId)).toEqual([
      'item-0',
      'item-1',
      'item-2',
      'item-3',
    ]);
  });

  it('centers without visible surfaces and responds to prominence without mutating inputs', () => {
    const centered = directStage({ width: 1000, height: 800 }, [
      { ...instances[0], minimized: true },
    ]);
    expect(centered.surfaces).toEqual([]);
    expect(centered.emblem).toEqual({
      x: 360,
      y: 260,
      width: 280,
      height: 280,
    });
    const layout = directStage({ width: 1440, height: 900 }, instances);
    expect(layout.surfaces[0].width).toBeGreaterThan(layout.surfaces[1].width);
    expect(instances[0].instanceId).toBe('item-0');
    expect(directStage({ width: NaN, height: -2 }, []).emblem.width).toBe(0);
  });
});
