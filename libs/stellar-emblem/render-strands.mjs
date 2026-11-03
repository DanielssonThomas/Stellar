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
  [0, 128, 128],
  [144, 144, 144],
  [144, 192, 255],
];

export async function measureFragmentCentroids(page, root, layers, size) {
  return page.evaluate(
    async ({ layers, size }) => {
      const images = new Map();
      const centroids = {};
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      for (const layer of layers) {
        let pixels = images.get(layer.file);
        if (!pixels) {
          const image = new Image();
          image.src = layer.src;
          await image.decode();
          ctx.clearRect(0, 0, size, size);
          ctx.drawImage(image, 0, 0);
          pixels = ctx.getImageData(0, 0, size, size).data;
          images.set(layer.file, pixels);
        }
        const [left, top, width, height] = layer.clip ?? [0, 0, size, size];
        let weight = 0,
          xSum = 0,
          ySum = 0;
        for (let y = top; y < top + height; y++)
          for (let x = left; x < left + width; x++) {
            const alpha = pixels[(y * size + x) * 4 + 3];
            if (alpha < 24) continue;
            weight += alpha;
            xSum += (x + 0.5) * alpha;
            ySum += (y + 0.5) * alpha;
          }
        if (!weight) throw new Error(`Empty centroid: ${layer.id}`);
        centroids[layer.id] = {
          x: Math.round((xSum / weight) * 100) / 100,
          y: Math.round((ySum / weight) * 100) / 100,
        };
      }
      return centroids;
    },
    {
      layers: layers
        .filter((layer) => !layer.spin)
        .map((layer) => ({
          ...layer,
          src:
            'data:image/png;base64,' +
            fs.readFileSync(path.join(root, layer.file)).toString('base64'),
        })),
      size,
    },
  );
}

export async function exportStrands(page, root, size, registration) {
  const evidence = [];
  const groups = ['gold', 'violet'].flatMap((color) => [
    { color, kind: 'hair', count: 12 },
    { color, kind: 'ornament', count: color === 'gold' ? 15 : 7 },
  ]);
  for (const { color, kind, count } of groups) {
    const dataUrl = (file) =>
      'data:image/png;base64,' +
      fs.readFileSync(path.join(root, file)).toString('base64');
    const result = await page.evaluate(
      async ({
        source,
        segmentation,
        palette,
        size,
        registration,
        color,
        kind,
      }) => {
        const load = async (src) => {
          const img = new Image();
          img.src = src;
          await img.decode();
          return img;
        };
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const map = await load(segmentation);
        if (registration)
          ctx.drawImage(
            map,
            registration.x,
            registration.y,
            1254 * registration.scale,
            1254 * registration.scale,
          );
        else ctx.drawImage(map, 0, 0, size, size);
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
          if (color === 'gold' && kind === 'ornament') {
            // Join the two map colors covering the upper-left leaf, then
            // reuse the spare label for the second lower-right leaf.
            if (labels[index] === 3) labels[index] = 1;
            if (labels[index] === 8) {
              const x =
                ((index % size) + 0.5 - registration.x) / registration.scale;
              const y =
                (Math.floor(index / size) + 0.5 - registration.y) /
                registration.scale;
              if (y > 700 + 0.6 * (x - 725)) labels[index] = 3;
            }
          }
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
        if (kind === 'ornament') {
          const neighbors = (index) => {
            const result = [];
            if (index >= size) result.push(index - size);
            if (index + size < labels.length) result.push(index + size);
            if (index % size > 0) result.push(index - 1);
            if (index % size < size - 1) result.push(index + 1);
            return result;
          };
          const cores = new Int8Array(labels.length).fill(-1);
          for (let index = 0; index < labels.length; index++)
            if (
              original[index * 4 + 3] >= 24 &&
              neighbors(index).every(
                (next) =>
                  labels[next] === labels[index] &&
                  original[next * 4 + 3] >= 24,
              )
            )
              cores[index] = labels[index];
          const visited = new Uint8Array(labels.length);
          const largest = Array.from({ length: palette.length }, () => []);
          for (let start = 0; start < cores.length; start++) {
            if (cores[start] < 0 || visited[start]) continue;
            const label = cores[start];
            let tail = 1;
            queue[0] = start;
            visited[start] = 1;
            for (let head = 0; head < tail; head++)
              for (const next of neighbors(queue[head]))
                if (!visited[next] && cores[next] === label) {
                  visited[next] = 1;
                  queue[tail++] = next;
                }
            if (tail > largest[label].length)
              largest[label] = Array.from(queue.subarray(0, tail));
          }
          labels.fill(-1);
          end = 0;
          largest.forEach((component, label) => {
            if (!component.length)
              throw new Error(`Missing leaf core ${label}`);
            for (const index of component) {
              labels[index] = label;
              queue[end++] = index;
            }
          });
          // Grow through the real ornament first, so a leaf's fringe cannot
          // jump the transparent gap onto another leaf's distant outline.
          for (let head = 0; head < end; head++)
            for (const next of neighbors(queue[head]))
              if (labels[next] < 0 && original[next * 4 + 3] >= 24) {
                labels[next] = labels[queue[head]];
                queue[end++] = next;
              }
          for (let head = 0; head < end; head++)
            for (const next of neighbors(queue[head]))
              if (labels[next] < 0) {
                labels[next] = labels[queue[head]];
                queue[end++] = next;
              }
          if (end !== labels.length)
            throw new Error('Incomplete leaf coverage');
        }
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
        source: dataUrl(`layers/${color}-${kind}.png`),
        segmentation: dataUrl(`sources/${color}-${kind}-segmentation-v2.png`),
        palette: palette.slice(0, count),
        color,
        kind,
        registration:
          kind === 'ornament'
            ? registration.layers.find(
                (layer) => layer.id === `${color}-${kind}`,
              )
            : null,
        size,
      },
    );
    result.forEach((fragment, index) =>
      fs.writeFileSync(
        path.join(root, 'layers', `${color}-${kind}-${index + 1}.png`),
        Buffer.from(fragment.png, 'base64'),
      ),
    );
    evidence.push({
      color,
      kind,
      fragments: result.length,
      visiblePixels: result.map((fragment) => fragment.visible),
      pixelIdentical: true,
    });
  }
  return evidence;
}
