import fs from 'node:fs';
import path from 'node:path';
import { optimizePng } from './optimize-png.mjs';

export async function exportRingArcs(page, root, geometries, size) {
  const evidence = [];
  for (const ring of geometries.filter((item) => item.id !== 'outer-frame')) {
    const source =
      'data:image/svg+xml;base64,' +
      fs
        .readFileSync(path.join(root, 'layers', `${ring.id}.svg`))
        .toString('base64');
    const arcs = await page.evaluate(
      async ({ source, size }) => {
        const load = async (src) => {
          const image = new Image();
          image.src = src;
          await image.decode();
          return image;
        };
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(await load(source), 0, 0);
        const original = ctx.getImageData(0, 0, size, size).data;
        const whole = document.createElement('canvas');
        whole.width = whole.height = size;
        const composed = whole.getContext('2d', { willReadFrequently: true });
        const fragments = [];
        for (let part = 0; part < 3; part++) {
          const pixels = ctx.createImageData(size, size);
          for (let p = 0; p < size * size; p++) {
            const angle =
              (Math.atan2(
                Math.floor(p / size) + 0.5 - size / 2,
                (p % size) + 0.5 - size / 2,
              ) +
                2 * Math.PI) %
              (2 * Math.PI);
            if (Math.floor(angle / ((2 * Math.PI) / 3)) !== part) continue;
            pixels.data.set(original.subarray(p * 4, p * 4 + 4), p * 4);
          }
          ctx.putImageData(pixels, 0, 0);
          const png = canvas.toDataURL('image/png');
          composed.drawImage(await load(png), 0, 0);
          fragments.push(png.split(',')[1]);
        }
        const final = composed.getImageData(0, 0, size, size).data;
        if (!final.every((byte, index) => byte === original[index]))
          throw new Error('Ring arc recomposition changes source pixels');
        return fragments;
      },
      { source, size },
    );
    arcs.forEach((png, index) =>
      fs.writeFileSync(
        path.join(root, 'layers', `${ring.id}-arc-${index + 1}.png`),
        optimizePng(Buffer.from(png, 'base64')),
      ),
    );
    evidence.push({ ring: ring.id, arcs: arcs.length, pixelIdentical: true });
  }
  return evidence;
}
