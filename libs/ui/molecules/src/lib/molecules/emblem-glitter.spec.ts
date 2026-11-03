import { describe, expect, it } from 'vitest';
import { nextGlitterRegions } from './emblem-glitter';

describe('traveling fragment lighting', () => {
  it('hands regions to adjacent pitches and advances on repeated-note attacks', () => {
    const first = nextGlitterRegions(136, 0, 69, null);
    const nextPitch = nextGlitterRegions(136, first.cursor, 70, 69);
    const repeated = nextGlitterRegions(136, first.cursor, 69, 69);
    expect(nextPitch.indices).not.toEqual(first.indices);
    expect(repeated.indices).not.toEqual(first.indices);
    expect(nextPitch.indices).not.toEqual(repeated.indices);
    expect(first.indices.length).toBe(21);
    expect(new Set(first.indices.map((index) => index % 2))).toEqual(
      new Set([0, 1]),
    );
  });
  it('keeps routing bounded and reaches every region over repeated beats', () => {
    let cursor = 0;
    const visited = new Set<number>();
    for (let i = 0; i < 136; i++) {
      const next = nextGlitterRegions(136, cursor, 69, 69);
      cursor = next.cursor;
      next.indices.forEach((index) => visited.add(index));
    }
    expect(visited.size).toBe(136);
    expect(nextGlitterRegions(0, 0, null, null).indices).toEqual([]);
  });
});
