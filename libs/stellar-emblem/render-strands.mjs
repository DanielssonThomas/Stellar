import fs from 'node:fs';
import path from 'node:path';

const palette = [
  [255, 48, 48],
  [255, 144, 32],
  [255, 255, 32],
  [128, 255, 32],
  [16, 176, 64],
  [32, 255, 255],
  [32, 64, 255],
  [144, 48, 255],
  [255, 32, 208],
  [255, 144, 176],
  [255, 255, 255],
  [128, 64, 32],
];

export async function exportStrands(page, root, size) {
  const evidence = [];
  for (const color of ['gold', 'violet']) {
    const dataUrl = (file) =>
      'data:image/png;base64,' +
      fs.readFileSync(path.join(root, file)).toString('base64');
    const result = await page.evaluate(
      async ({ source, segmentation, palette, size }) => {
        const load = async (src) => {
          const img = new Image();
          img.src = src;
          await img.decode();
          return img;
        };
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(await load(segmentation), 0, 0, size, size);
        const mask = ctx.getImageData(0, 0, size, size).data;
        const labels = new Int8Array(size * size).fill(-1);
        const queue = new Int32Array(labels.length);
        let end = 0;
        for (let index = 0; index < labels.length; index++) {
          const offset = index * 4;
          const rgb = [mask[offset], mask[offset + 1], mask[offset + 2]];
          if (Math.max(...rgb) < 64) continue;
          let best = Infinity;
          palette.forEach((target, label) => {
            const distance = target.reduce(
              (sum, channel, c) => sum + (channel - rgb[c]) ** 2,
              0,
            );
            if (distance < best) {
              best = distance;
              labels[index] = label;
            }
          });
          queue[end++] = index;
        }
        // Extend the nearest label into any silhouette drift in the authored map.
        // Only labels change: each source pixel is copied to exactly one fragment.
        for (let head = 0; head < end; head++) {
          const index = queue[head],
            x = index % size;
          const neighbors = [index - size, index + size];
          if (x > 0) neighbors.push(index - 1);
          if (x < size - 1) neighbors.push(index + 1);
          for (const next of neighbors) {
            if (next < 0 || next >= labels.length || labels[next] !== -1)
              continue;
            labels[next] = labels[index];
            queue[end++] = next;
          }
        }
        if (end !== labels.length)
          throw new Error('Incomplete strand segmentation');
        ctx.clearRect(0, 0, size, size);
        ctx.drawImage(await load(source), 0, 0);
        const original = ctx.getImageData(0, 0, size, size).data;
        const fragments = [];
        const assembly = document.createElement('canvas');
        assembly.width = assembly.height = size;
        const assembled = assembly.getContext('2d', {
          willReadFrequently: true,
        });
        for (let label = 0; label < palette.length; label++) {
          const pixels = ctx.createImageData(size, size);
          let visible = 0;
          for (let index = 0; index < labels.length; index++) {
            if (labels[index] !== label) continue;
            const offset = index * 4;
            pixels.data.set(original.subarray(offset, offset + 4), offset);
            if (original[offset + 3] >= 24) visible++;
          }
          if (visible < 32) throw new Error(`Negligible strand label ${label}`);
          ctx.putImageData(pixels, 0, 0);
          const png = canvas.toDataURL('image/png');
          assembled.drawImage(await load(png), 0, 0);
          fragments.push({ png: png.split(',')[1], visible });
        }
        const final = assembled.getImageData(0, 0, size, size).data;
        if (!final.every((byte, index) => byte === original[index]))
          throw new Error('Strand assembly changes original pixels');
        return fragments;
      },
      {
        source: dataUrl(`layers/${color}-hair.png`),
        segmentation: dataUrl(`sources/${color}-hair-segmentation-v2.png`),
        palette,
        size,
      },
    );
    result.forEach((fragment, index) =>
      fs.writeFileSync(
        path.join(root, 'layers', `${color}-hair-${index + 1}.png`),
        Buffer.from(fragment.png, 'base64'),
      ),
    );
    evidence.push({
      color,
      fragments: result.length,
      visiblePixels: result.map((fragment) => fragment.visible),
      pixelIdentical: true,
    });
  }
  return evidence;
}
