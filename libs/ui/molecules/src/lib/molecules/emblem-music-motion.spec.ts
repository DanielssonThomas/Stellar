import { describe, expect, it } from 'vitest';
import { musicTransform } from './emblem-music-motion';
import type { EmblemLayer } from './emblem-motion-model';

const layer: EmblemLayer = {
  id: 'hair',
  file: 'layers/violet-hair-1.png',
  z: 1,
  anchor: { x: 640, y: 640 },
  assembled: { x: 0, y: 0, rotation: 0 },
  exploded: { x: 0, y: 0, rotation: 0 },
};
describe('music displacement', () => {
  it('keeps ring centers, spacing and scale intact at every intensity', () =>
    expect(
      musicTransform({ ...layer, spin: 'clockwise' }, 2, {
        level: 1,
        bass: 1,
        mid: 1,
        treble: 1,
      }),
    ).toBe('none'));
  it('bounds invalid and amplified features and follows opposing depth groups', () => {
    const levels = { level: 10, bass: 1, mid: NaN, treble: -5 };
    expect(musicTransform(layer, 0, levels)).toContain('-2.800cqw');
    expect(musicTransform({ ...layer, file: 'gold.png' }, 0, levels)).toContain(
      '2.800cqw',
    );
    expect(musicTransform(layer, 1, levels)).not.toMatch(/NaN|Infinity/);
  });
});
