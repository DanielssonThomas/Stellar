import { describe, expect, it } from 'vitest';
import {
  clampAudioLevel,
  EmblemManifest,
  isExplodedPhase,
  layerOrigin,
  layerTransform,
  manifestError,
} from './emblem-motion-model';

const layer = {
  id: 'face',
  file: 'layers/face.svg',
  z: 1,
  anchor: { x: 266, y: 276 },
  assembled: { x: 0, y: 0, rotation: 0 },
  exploded: { x: 128, y: -64, rotation: 5 },
};
const manifest: EmblemManifest = {
  version: 1,
  viewBox: [10, 20, 512, 512],
  layers: [{ ...layer, id: 'ring', z: 0 }, layer],
};

describe('emblem motion model', () => {
  it('preserves assembled geometry and expresses exploded motion in relative coordinates', () => {
    expect(manifestError(manifest)).toBeNull();
    expect(layerTransform(layer, manifest, 'idle', false)).toContain(
      'translateZ(0px) rotate(0deg)',
    );
    expect(layerTransform(layer, manifest, 'listening', false)).toContain(
      'translate(25% , -12.5%) translateZ(9px) rotate(5deg)',
    );
    expect(layerTransform(layer, manifest, 'listening', true)).toContain(
      'translateZ(0px)',
    );
    expect(layerOrigin(layer, manifest)).toBe('50% 50%');
    expect(layer.assembled).toEqual({ x: 0, y: 0, rotation: 0 });
  });

  it('selects semantic poses and clamps invalid audio values', () => {
    expect(isExplodedPhase('focusing')).toBe(true);
    expect(isExplodedPhase('listening')).toBe(true);
    expect(isExplodedPhase('hangover')).toBe(true);
    expect(isExplodedPhase('presenting')).toBe(false);
    expect([-2, 0, 0.4, 2, NaN, Infinity].map(clampAudioLevel)).toEqual([
      0, 0, 0.4, 1, 0, 0,
    ]);
  });

  it.each([
    '../face.svg',
    'layers\\face.svg',
    '/face.svg',
    'https://x/face.svg',
    'layers//face.svg',
    'layers/%2e%2e/face.svg',
    './face.svg',
    'face.svg?x=1',
  ])('rejects unsafe file %s', (file) => {
    expect(
      manifestError({ ...manifest, layers: [{ ...layer, file }] }),
    ).not.toBeNull();
  });

  it.each([
    null,
    {},
    { ...manifest, viewBox: [0, 0, 0, 512] },
    { ...manifest, layers: new Array(1) },
    { ...manifest, layers: [layer, layer] },
    {
      ...manifest,
      layers: [{ ...layer, exploded: { x: NaN, y: 0, rotation: 0 } }],
    },
  ])('rejects malformed external manifest %#', (value) => {
    expect(manifestError(value as EmblemManifest | null)).not.toBeNull();
  });
});
