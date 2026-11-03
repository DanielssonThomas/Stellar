import { describe, expect, it } from 'vitest';
import {
  clampAudioLevel,
  decodeEmblemManifest,
  EmblemManifest,
  isExplodedPhase,
  layerOrigin,
  layerTransform,
  manifestError,
  consolidatedClipFiles,
  consolidatedFragmentFiles,
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
  it('moves outer fragment centers onto an elliptical envelope without changing depth or assembly', () => {
    const tapered: EmblemManifest = {
      version: 1,
      viewBox: [0, 0, 100, 100],
      planeSpacing: 100,
      radialTaper: 0.8,
      layers: Array.from({ length: 5 }, (_, index) => ({
        ...layer,
        id: `lock-${index}`,
        planeIndex: index,
        anchor: { x: 50, y: 50 },
        centroid: { x: 100, y: 50 },
        exploded: { x: 0, y: 0, rotation: 0 },
      })),
    };
    expect(manifestError(tapered)).toBeNull();
    const translation = (transform: string) =>
      transform
        .match(/translate\(([-\d.e]+)% , ([-\d.e]+)%\)/)
        ?.slice(1)
        .map(Number) ?? [];
    const offsets = tapered.layers.map((item) =>
      translation(layerTransform(item, tapered, 'idle', true)),
    );
    expect(offsets[0][0]).toBeCloseTo(-20);
    expect(offsets[0]).toEqual(offsets[4]);
    expect(offsets[2]).toEqual([0, 0]);
    expect(Math.abs(offsets[1][0])).toBeLessThan(Math.abs(offsets[0][0]));
    expect(layerTransform(tapered.layers[0], tapered, 'idle', true)).toContain(
      'translateZ(-200cqw)',
    );
    expect(
      translation(
        layerTransform(tapered.layers[0], tapered, 'listening', false),
      ),
    ).toEqual([0, 0]);
    const rotated = {
      ...tapered.layers[0],
      exploded: { x: 10, y: 0, rotation: 90 },
    };
    const rotatedOffset = translation(
      layerTransform(rotated, tapered, 'idle', false),
    );
    expect(rotatedOffset[0]).toBeCloseTo(6);
    expect(rotatedOffset[1]).toBeCloseTo(-20);
    expect(
      translation(
        layerTransform(
          { ...tapered.layers[0], centroid: undefined },
          tapered,
          'idle',
          false,
        ),
      ),
    ).toEqual([0, 0]);
    for (const radialTaper of [-0.1, 1.1, NaN, null, '0.8'])
      expect(decodeEmblemManifest({ ...tapered, radialTaper })).toBeNull();
    expect(
      decodeEmblemManifest({
        ...tapered,
        layers: tapered.layers.map((item) => ({
          ...item,
          centroid: { x: 101, y: 50 },
        })),
      }),
    ).toBeNull();
  });
  it('validates complete strand groups and consolidates only registered contiguous paint', () => {
    const group: EmblemManifest = {
      ...manifest,
      layers: [0, 1].map((index) => ({
        ...layer,
        id: `strand-${index}`,
        file: `layers/strand-${index}.png`,
        z: index,
        assembly: { file: 'layers/hair.png', index, count: 2 },
        assembled: { x: 0, y: 0, rotation: 0 },
      })),
    };
    expect(decodeEmblemManifest(group)).toEqual(group);
    expect([...consolidatedFragmentFiles(group)]).toEqual(['layers/hair.png']);
    expect(
      consolidatedFragmentFiles({
        ...group,
        layers: [
          group.layers[0],
          { ...group.layers[1], assembled: { x: 1, y: 0, rotation: 0 } },
        ],
      }).size,
    ).toBe(0);
    expect(
      consolidatedFragmentFiles({
        ...group,
        layers: [group.layers[0], { ...layer, z: 0.5 }, group.layers[1]],
      }).size,
    ).toBe(0);
    for (const assembly of [
      null,
      { file: '../hair.png', index: 1, count: 2 },
      { file: 'layers/hair.png', index: 0, count: 2 },
      { file: 'layers/hair.png', index: 1, count: 3 },
    ])
      expect(
        decodeEmblemManifest({
          ...group,
          layers: [group.layers[0], { ...group.layers[1], assembly }],
        }),
      ).toBeNull();
  });
  it('accepts dense fragment packs and rejects unbounded or unknown spacing profiles', () => {
    const dense: EmblemManifest = {
      ...manifest,
      planeSpacing: 100,
      spacingProfile: 'outer-dense',
      layers: Array.from({ length: 73 }, (_, index) => ({
        ...layer,
        id: `fragment-${index}`,
        planeIndex: index,
      })),
    };
    expect(decodeEmblemManifest(dense)).toEqual(dense);
    expect(layerTransform(dense.layers[36], dense, 'idle', true)).toContain(
      'translateZ(0cqw)',
    );
    expect(
      decodeEmblemManifest({ ...dense, spacingProfile: 'random' }),
    ).toBeNull();
    expect(
      decodeEmblemManifest({ ...manifest, spacingProfile: 'outer-dense' }),
    ).toBeNull();
    expect(
      decodeEmblemManifest({
        ...dense,
        layers: Array.from({ length: 97 }, (_, index) => ({
          ...layer,
          id: `fragment-${index}`,
          planeIndex: index,
        })),
      }),
    ).toBeNull();
  });
  it('consolidates only registered zero-pose clips without interleaved paint', () => {
    const fragments: EmblemManifest = {
      ...manifest,
      viewBox: [0, 0, 512, 512],
      layers: [
        { ...layer, id: 'top', z: 0, clip: [0, 0, 512, 256] },
        { ...layer, id: 'bottom', z: 2, clip: [0, 256, 512, 256] },
      ],
    };
    expect(consolidatedClipFiles(fragments).has(layer.file)).toBe(true);
    const moved: EmblemManifest = {
      ...fragments,
      layers: [
        fragments.layers[0],
        { ...fragments.layers[1], assembled: { x: 20, y: 0, rotation: 0 } },
      ],
    };
    expect(decodeEmblemManifest(moved)).not.toBeNull();
    expect(consolidatedClipFiles(moved).size).toBe(0);
    const interleaved: EmblemManifest = {
      ...fragments,
      layers: [
        fragments.layers[0],
        { ...layer, id: 'other', file: 'layers/other.svg', z: 1 },
        fragments.layers[1],
      ],
    };
    expect(decodeEmblemManifest(interleaved)).not.toBeNull();
    expect(consolidatedClipFiles(interleaved).size).toBe(0);
    const otherOrigin: EmblemManifest = {
      ...fragments,
      layers: [
        fragments.layers[0],
        { ...fragments.layers[1], anchor: { x: 20, y: 30 } },
      ],
    };
    expect(consolidatedClipFiles(otherOrigin).size).toBe(0);
  });
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
