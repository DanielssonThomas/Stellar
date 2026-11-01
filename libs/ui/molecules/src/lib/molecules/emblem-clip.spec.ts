import { describe, expect, it } from 'vitest';
import {
  completeClipFiles,
  emblemClipPath,
  validEmblemClip,
} from './emblem-clip';
import {
  decodeEmblemManifest,
  type EmblemManifest,
} from './emblem-motion-model';
const production: EmblemManifest = {
  version: 1,
  viewBox: [0, 0, 1280, 1280],
  layers: [
    {
      id: 'face',
      file: 'layers/face.png',
      z: 0,
      anchor: { x: 640, y: 640 },
      assembled: { x: 0, y: 0, rotation: 0 },
      exploded: { x: 0, y: 0, rotation: 0 },
    },
  ],
};

describe('registered face fragments', () => {
  it('consolidates only complete disjoint partitions, never partial or overlapping clips', () => {
    const layer = (clip: readonly [number, number, number, number]) => ({
      file: 'face.png',
      clip,
    });
    const box = [0, 0, 1280, 1280] as const;
    expect(
      completeClipFiles(
        [layer([0, 0, 1280, 512]), layer([0, 512, 1280, 768])],
        box,
      ).has('face.png'),
    ).toBe(true);
    expect(completeClipFiles([layer([0, 0, 1280, 512])], box).size).toBe(0);
    expect(
      completeClipFiles(
        [layer([0, 0, 1280, 640]), layer([0, 0, 1280, 640])],
        box,
      ).size,
    ).toBe(0);
  });
  it('preserves the legacy path and handles registered origins', () => {
    expect(emblemClipPath(undefined, [0, 0, 1280, 1280])).toBe('none');
    expect(emblemClipPath([10, 45, 100, 25], [10, 20, 100, 100])).toBe(
      'inset(25% 0% 50% 0%)',
    );
  });
  it.each([
    null,
    'inset(0)',
    [0, 0, 0, 1280],
    [0, 0, 1281, 1280],
    [0, -1, 1280, 100],
    [0, 0, 1280, Infinity],
    [0, 0, 1280, 1280, 1],
    [0, 0, 1280, 0.5],
  ])('rejects unsafe or invalid clips %o', (clip) => {
    expect(validEmblemClip(clip, [0, 0, 1280, 1280])).toBe(false);
    expect(
      decodeEmblemManifest({
        ...production,
        layers: production.layers.map((layer, index) =>
          index === 0 ? { ...layer, clip } : layer,
        ),
      }),
    ).toBeNull();
  });
  it('accepts a bounded clip through the existing manifest boundary', () => {
    expect(decodeEmblemManifest(production)).not.toBeNull();
    expect(
      decodeEmblemManifest({
        ...production,
        layers: [{ ...production.layers[0], clip: [0, 0, 1280, 512] }],
      }),
    ).not.toBeNull();
  });
});
