import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { rasterSizes } from './render-resolutions.mjs';

const root = path.join(import.meta.dirname, 'production-v1');
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'),
);

describe('responsive emblem distribution', () => {
  it('ships real registered PNG dimensions for every fragment and assembled raster at every advertised size', () => {
    const files = [
      ...new Set(
        manifest.layers.flatMap((layer) => [
          layer.file,
          ...(layer.assembly ? [layer.assembly.file] : []),
        ]),
      ),
    ].filter((file) => file.endsWith('.png'));
    expect(manifest.rasterSizes).toEqual(rasterSizes);
    expect(files).toHaveLength(86);
    for (const width of rasterSizes)
      for (const file of files) {
        const png = fs.readFileSync(
          path.join(root, 'resolutions', String(width), file),
        );
        expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
        expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([
          width,
          width,
        ]);
        expect(png.readUInt8(25)).toBe(6);
      }
  });
});
