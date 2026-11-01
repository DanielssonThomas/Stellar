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
  it.each([
    { width: 1440, height: 900 },
    { width: 320, height: 600 },
    { width: 80, height: 80 },
    { width: 0, height: 0 },
  ])(
    'keeps independent surfaces and emblem inside resized bounds %o',
    (viewport) => {
      const layout = directStage(viewport, instances);
      const rects = [...layout.surfaces, layout.emblem];
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
