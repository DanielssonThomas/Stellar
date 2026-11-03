import { describe, expect, it } from 'vitest';
import { planeDepth } from './emblem-stack';

describe('equal emblem stack', () => {
  it('retains the old five-ring core while compressing only the outer fragments', () => {
    const core = { count: 5, spacing: 240 };
    const depths = Array.from({ length: 47 }, (_, index) =>
      planeDepth(index, 47, 80, 'outer-dense', core),
    );
    expect(depths.slice(21, 26)).toEqual([-480, -240, 0, 240, 480]);
    const gaps = depths
      .slice(1, 22)
      .map((depth, index) => depth - depths[index]);
    gaps
      .slice(1)
      .forEach((gap, index) => expect(gap).toBeGreaterThan(gaps[index]));
    expect(gaps.at(-1)).toBeLessThan(80);
    for (const invalid of [
      { count: 4, spacing: 240 },
      { count: 49, spacing: 240 },
      { count: 5, spacing: 0 },
    ])
      expect(() => planeDepth(0, 47, 80, 'outer-dense', invalid)).toThrow();
  });
  it.each([1, 2, 11, 32])('centers every interval for %i planes', (count) => {
    const depths = Array.from({ length: count }, (_, index) =>
      planeDepth(index, count),
    );
    expect(depths[0] + depths[count - 1]).toBe(0);
    expect(depths.reduce((sum, depth) => sum + depth, 0)).toBe(0);
    depths
      .slice(1)
      .forEach((depth, index) => expect(depth - depths[index]).toBe(240));
    expect(Math.max(...depths.map(Math.abs))).toBeLessThanOrEqual(4096);
  });
  it.each([
    [0, 0, 240],
    [-1, 11, 240],
    [11, 11, 240],
    [0, 97, 240],
    [0, 2.5, 240],
    [0.5, 11, 240],
    [NaN, 11, 240],
    [0, 11, Infinity],
    [0, 11, 0],
    [0, 11, 257],
  ])('rejects invalid spacing inputs %o', (index, count, spacing) => {
    expect(() => planeDepth(index, count, spacing)).toThrow(RangeError);
  });
  it.each([2, 15, 47, 64])(
    'compresses outer gaps symmetrically without crossing for %i planes',
    (count) => {
      const depths = Array.from({ length: count }, (_, index) =>
        planeDepth(index, count, 100, 'outer-dense'),
      );
      const gaps = depths.slice(1).map((depth, index) => depth - depths[index]);
      depths.forEach((depth, index) =>
        expect(depth).toBeCloseTo(-depths[count - index - 1], 10),
      );
      expect(gaps.every((gap) => gap > 0)).toBe(true);
      const half = gaps.slice(0, Math.ceil(gaps.length / 2));
      half
        .slice(1)
        .forEach((gap, index) => expect(gap).toBeGreaterThan(half[index]));
      expect(gaps[0]).toBeLessThanOrEqual(gaps[Math.floor(gaps.length / 2)]);
      expect(Math.max(...depths.map(Math.abs))).toBeLessThan(2400);
    },
  );
});
