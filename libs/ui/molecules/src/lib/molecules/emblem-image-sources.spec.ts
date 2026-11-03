import { describe, expect, it } from 'vitest';
import { emblemImageSource } from './emblem-image-sources';
import type { EmblemManifest } from './emblem-motion-model';

const manifest: EmblemManifest = {
  version: 1,
  viewBox: [0, 0, 1280, 1280],
  layers: [],
  rasterSizes: [128, 512, 1024],
};

describe('emblem image sources', () => {
  it('keeps original fallback and full-resolution candidate with density-independent width descriptors', () => {
    expect(emblemImageSource('layers/hair.png', '/emblem/', manifest)).toEqual({
      src: '/emblem/layers/hair.png',
      srcset:
        '/emblem/resolutions/128/layers/hair.png 128w, /emblem/resolutions/512/layers/hair.png 512w, /emblem/resolutions/1024/layers/hair.png 1024w, /emblem/layers/hair.png 1280w',
    });
    expect(emblemImageSource('layers/hair.png', '', manifest).srcset).toContain(
      'resolutions/128/layers/hair.png 128w',
    );
  });
  it('leaves vector and legacy sources at their canonical URLs', () => {
    expect(emblemImageSource('layers/ring.svg', '/emblem', manifest)).toEqual({
      src: '/emblem/layers/ring.svg',
      srcset: null,
    });
    expect(
      emblemImageSource('layers/hair.png', '/emblem', {
        ...manifest,
        rasterSizes: undefined,
      }),
    ).toEqual({ src: '/emblem/layers/hair.png', srcset: null });
  });
});
