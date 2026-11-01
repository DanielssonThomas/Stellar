import { describe, expect, it } from 'vitest';
import { planeDepth } from './emblem-stack';

describe('equal emblem stack', () => {
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
    [0, 33, 240],
    [0, 2.5, 240],
    [0.5, 11, 240],
    [NaN, 11, 240],
    [0, 11, Infinity],
    [0, 11, 0],
    [0, 11, 257],
  ])('rejects invalid spacing inputs %o', (index, count, spacing) => {
    expect(() => planeDepth(index, count, spacing)).toThrow(RangeError);
  });
});
