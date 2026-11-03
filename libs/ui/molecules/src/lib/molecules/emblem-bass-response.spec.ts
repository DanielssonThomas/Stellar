import { describe, expect, it } from 'vitest';
import {
  bassSizeAt,
  bassSizePush,
  closestBassRings,
} from './emblem-bass-response';
import type { EmblemLayer } from './emblem-motion-model';

describe('bass size response', () => {
  it('shrinks at the same rate for quiet and loud impulses and does not hold on sustained bass', () => {
    const quiet = bassSizePush(null, 0.5, 0, 0, 'dynamic');
    const loud = bassSizePush(null, 1, 0, 0, 'dynamic');
    expect(quiet).not.toBeNull();
    expect(loud).not.toBeNull();
    expect(bassSizeAt(quiet, 100) - bassSizeAt(quiet, 200)).toBeCloseTo(0.016);
    expect(bassSizeAt(loud, 100) - bassSizeAt(loud, 200)).toBeCloseTo(0.016);
    expect(bassSizeAt(quiet, 2000)).toBe(0);
    expect(bassSizeAt(loud, 4000)).toBe(0);
    expect(bassSizePush(loud, 1, 1, 100, 'dynamic')).toBeNull();
    expect(bassSizePush(loud, 0.1, 0, 100, 'dynamic')).toBeNull();
    const pushed = bassSizePush(quiet, 1, 0, 200, 'dynamic');
    expect(bassSizeAt(pushed, 200)).toBeGreaterThan(bassSizeAt(quiet, 200));
  });
  it('allows large bass expansions while preserving the same release speed', () => {
    expect(bassSizePush(null, 1, 0, 0, 'calm')?.extra).toBe(0.18);
    expect(bassSizePush(null, 1, 0, 0, 'dynamic')?.extra).toBe(0.6);
    const flashy = bassSizePush(null, 1, 0, 0, 'flashy');
    expect(flashy?.extra).toBe(0.9);
    expect(bassSizeAt(flashy, 1000)).toBeCloseTo(0.74);
  });
  it('selects complete fragmented ring groups nearest the middle on either depth side', () => {
    const layer: EmblemLayer = {
      id: 'middle',
      file: 'ring.svg',
      z: 0,
      anchor: { x: 640, y: 640 },
      spin: 'clockwise',
      assembled: { x: 0, y: 0, rotation: 0 },
      exploded: { x: 0, y: 0, rotation: 0 },
    };
    const arcs = (name: string, depth: number) =>
      [0, 1, 2].map((index) => ({
        ...layer,
        id: name + index,
        assembly: { file: name + '.svg', index, count: 3 },
        exploded: { ...layer.exploded, depth: depth + index },
      }));
    expect(
      [
        ...closestBassRings([
          layer,
          ...arcs('far-left', -500),
          ...arcs('near-left', -170),
          ...arcs('near-right', 150),
          ...arcs('far-right', 500),
        ]),
      ].sort(),
    ).toEqual([
      'near-left0',
      'near-left1',
      'near-left2',
      'near-right0',
      'near-right1',
      'near-right2',
    ]);
  });
});
