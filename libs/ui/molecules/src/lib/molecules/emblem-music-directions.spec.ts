import { describe, expect, it } from 'vitest';
import { emblemMusicDirections } from './emblem-music-directions';
import { musicTransform } from './emblem-music-motion';
import type { EmblemLayer, EmblemManifest } from './emblem-motion-model';

describe('outward music directions', () => {
  const layer: EmblemLayer = {
    id: 'right',
    file: 'body.png',
    z: 1,
    anchor: { x: 640, y: 640 },
    centroid: { x: 800, y: 640 },
    assembled: { x: 0, y: 0, rotation: 0 },
    exploded: { x: 0, y: 0, rotation: 90, depth: 200 },
  };
  const opposite = {
    ...layer,
    id: 'left',
    exploded: { ...layer.exploded, depth: -200 },
  };
  const manifest: EmblemManifest = {
    version: 1,
    viewBox: [0, 0, 1280, 1280],
    layers: [layer, opposite],
  };
  it('uses actual depth sides and counter-rotates the high-energy pull toward the shared axis', () => {
    const directions = emblemMusicDirections(manifest);
    const right = directions.get('right')!;
    const left = directions.get('left')!;
    expect(right.outward).toBeGreaterThan(0);
    expect(left.outward).toBeLessThan(0);
    expect(right.inwardX).toBeCloseTo(-2.5);
    expect(right.inwardY).toBeCloseTo(0);
    expect(
      musicTransform(
        layer,
        0,
        { level: 0.5, bass: 0.5, mid: 0.5, treble: 0.5 },
        'dynamic',
        right,
      ),
    ).toMatch(/^translate3d\(0\.000%, 0\.000%,/);
    const loud = musicTransform(
      layer,
      0,
      { level: 1, bass: 1, mid: 1, treble: 1 },
      'dynamic',
      right,
    );
    expect(loud).toContain('-2.500%');
    expect(loud).not.toContain('rotate');
  });
  it.each([
    'gold-hair.png',
    'violet-hair.png',
    'gold-ornament.png',
    'violet-jewelry.png',
  ])('only increases depth spacing for %s at any intensity', (file) => {
    const hair = { ...layer, assembly: { file, index: 0, count: 2 } };
    const direction = emblemMusicDirections({
      ...manifest,
      layers: [hair],
    }).get(hair.id)!;
    expect(direction.inwardX).toBe(0);
    expect(direction.inwardY).toBe(0);
    expect(
      musicTransform(
        hair,
        0,
        { level: 1, bass: 1, mid: 1, treble: 1 },
        'flashy',
        direction,
      ),
    ).toBe('translate3d(0.000%, 0.000%, 6.000cqw)');
  });
});
