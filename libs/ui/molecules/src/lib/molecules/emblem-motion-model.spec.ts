import { describe, expect, it } from 'vitest';
import {
  clampAudioLevel,
  decodeEmblemManifest,
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
  it('uses validated plane indices instead of paint order and retains equal depth under reduced motion', () => {
    const spaced: EmblemManifest = {
      ...manifest,
      planeSpacing: 240,
      layers: [
        { ...layer, id: 'front', z: 0, planeIndex: 1 },
        { ...layer, id: 'back', z: 5, planeIndex: 0 },
      ],
    };
    expect(manifestError(spaced)).toBeNull();
    expect(layerTransform(spaced.layers[0], spaced, 'idle', true)).toContain(
      'translateZ(23.4375cqw)',
    );
    expect(layerTransform(spaced.layers[1], spaced, 'idle', false)).toContain(
      'translateZ(-23.4375cqw)',
    );
    expect(
      layerTransform(spaced.layers[0], spaced, 'listening', false),
    ).toContain('translateZ(0px)');
    for (const indices of [
      [0, 0],
      [0, 2],
      [0, undefined],
      [0, NaN],
    ])
      expect(
        manifestError({
          ...spaced,
          layers: spaced.layers.map((item, index) => ({
            ...item,
            planeIndex: indices[index],
          })),
        }),
      ).not.toBeNull();
    expect(manifestError({ ...spaced, planeSpacing: Infinity })).not.toBeNull();
  });
  it('keeps explicit separated depth under reduced motion and rejects invalid depth', () => {
    const spatial = { ...layer, exploded: { ...layer.exploded, depth: 256 } };
    expect(layerTransform(spatial, manifest, 'idle', true)).toContain(
      'translateZ(50cqw)',
    );
    expect(layerTransform(spatial, manifest, 'listening', true)).toContain(
      'translateZ(0px)',
    );
    for (const depth of [NaN, Infinity, -Infinity, 4097, '256']) {
      expect(
        decodeEmblemManifest({
          ...manifest,
          layers: [{ ...spatial, exploded: { ...spatial.exploded, depth } }],
        }),
      ).toBeNull();
    }
  });
  it('decodes imported JSON through the existing geometry and resource checks', () => {
    expect(decodeEmblemManifest(JSON.parse(JSON.stringify(manifest)))).toEqual(
      manifest,
    );
    expect(decodeEmblemManifest({ ...manifest, viewBox: [0, 0] })).toBeNull();
    expect(
      decodeEmblemManifest({
        ...manifest,
        layers: [{ ...layer, file: 'https://remote/layer.svg' }],
      }),
    ).toBeNull();
    expect(decodeEmblemManifest(null)).toBeNull();
  });
  it('preserves assembled geometry and expresses exploded motion in relative coordinates', () => {
    expect(manifestError(manifest)).toBeNull();
    expect(layerTransform(layer, manifest, 'listening', false)).toContain(
      'translateZ(0px) rotate(0deg)',
    );
    expect(layerTransform(layer, manifest, 'idle', false)).toContain(
      'translate(25% , -12.5%) translateZ(9px) rotate(5deg)',
    );
    expect(layerTransform(layer, manifest, 'idle', true)).toContain(
      'translateZ(0px)',
    );
    expect(layerOrigin(layer, manifest)).toBe('50% 50%');
    expect(layer.assembled).toEqual({ x: 0, y: 0, rotation: 0 });
  });

  it('selects semantic poses and clamps invalid audio values', () => {
    expect(isExplodedPhase('idle')).toBe(true);
    expect(isExplodedPhase('returning')).toBe(true);
    expect(isExplodedPhase('suspended')).toBe(true);
    expect(isExplodedPhase('focusing')).toBe(false);
    expect(isExplodedPhase('listening')).toBe(false);
    expect(isExplodedPhase('hangover')).toBe(false);
    expect(isExplodedPhase('docking')).toBe(false);
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
    '../face.png',
    'https://x/face.webp',
    'face.png?x=1',
    'face.webp#fragment',
    'face.png.svg/../face.png',
    'face.gif',
  ])('rejects unsafe file %s', (file) => {
    expect(
      manifestError({ ...manifest, layers: [{ ...layer, file }] }),
    ).not.toBeNull();
  });

  it.each(['layers/face.svg', 'layers/face.png', 'layers/face.webp'])(
    'accepts the safe hybrid layer path %s',
    (file) => {
      expect(
        manifestError({ ...manifest, layers: [{ ...layer, file }] }),
      ).toBeNull();
    },
  );

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
