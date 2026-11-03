import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { optimizePng } from './optimize-png.mjs';

export const rasterSizes = [128, 256, 512, 768, 1024];

export async function exportResolutions(page, root, manifest) {
  const files = [
    ...new Set(
      manifest.layers.flatMap((layer) => [
        layer.file,
        ...(layer.assembly ? [layer.assembly.file] : []),
      ]),
    ),
  ];
  const rasters = files.filter((file) => file.endsWith('.png'));
  for (const file of rasters) {
    const variants = await page.evaluate(
      async ({ src, widths, sourceWidth, sourceHeight }) => {
        const image = new Image();
        image.src = src;
        await image.decode();
        if (
          image.naturalWidth !== sourceWidth ||
          image.naturalHeight !== sourceHeight
        )
          throw new Error('Resolution source must match the registered canvas');
        return widths.map((width) => {
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = Math.round((sourceHeight * width) / sourceWidth);
          const context = canvas.getContext('2d');
          context.imageSmoothingEnabled = true;
          context.imageSmoothingQuality = 'high';
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          return canvas.toDataURL('image/png').split(',')[1];
        });
      },
      {
        src: `data:image/png;base64,${fs.readFileSync(path.join(root, file)).toString('base64')}`,
        widths: rasterSizes,
        sourceWidth: manifest.viewBox[2],
        sourceHeight: manifest.viewBox[3],
      },
    );
    for (const [index, size] of rasterSizes.entries()) {
      const destination = path.join(root, 'resolutions', String(size), file);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(
        destination,
        optimizePng(Buffer.from(variants[index], 'base64')),
      );
    }
  }
  const manifestBytes = fs.statSync(path.join(root, 'manifest.json')).size;
  const vectorBytes = files
    .filter((file) => !rasters.includes(file))
    .reduce(
      (total, file) => total + fs.statSync(path.join(root, file)).size,
      0,
    );
  const tiers = [...rasterSizes, manifest.viewBox[2]].map((width) => {
    const prefix = width === manifest.viewBox[2] ? '' : `resolutions/${width}/`;
    return {
      width,
      runtimeBytes:
        manifestBytes +
        vectorBytes +
        rasters.reduce(
          (total, file) =>
            total + fs.statSync(path.join(root, prefix, file)).size,
          0,
        ),
      rgbaBytes:
        rasters.length *
        width *
        Math.round((manifest.viewBox[3] * width) / manifest.viewBox[2]) *
        4,
    };
  });
  const distributionBytes =
    manifestBytes +
    vectorBytes +
    tiers.reduce(
      (total, tier) => total + tier.runtimeBytes - manifestBytes - vectorBytes,
      0,
    );
  if (tiers.some((tier) => tier.runtimeBytes > 8 * 1024 * 1024))
    throw new Error('A resolution tier exceeds the 8 MiB runtime budget');
  if (distributionBytes > 16 * 1024 * 1024)
    throw new Error('Responsive distribution exceeds the 16 MiB bundle budget');
  return {
    rasterFiles: rasters.length,
    tiers,
    distributionBytes,
    budgetBytes: 16 * 1024 * 1024,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const { chromium } = createRequire(import.meta.url)('@playwright/test');
  const root = path.join(import.meta.dirname, 'production-v1');
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'),
  );
  manifest.rasterSizes = rasterSizes;
  const { format } = createRequire(import.meta.url)('prettier');
  fs.writeFileSync(
    path.join(root, 'manifest.json'),
    await format(JSON.stringify(manifest), { parser: 'json' }),
  );
  const browser = await chromium.launch({ headless: true });
  try {
    const responsiveImages = await exportResolutions(
      await browser.newPage(),
      root,
      manifest,
    );
    const validationPath = path.join(root, 'previews/validation.json');
    const validation = JSON.parse(fs.readFileSync(validationPath, 'utf8'));
    validation.runtimeBytes = responsiveImages.tiers.at(-1).runtimeBytes;
    validation.responsiveImages = responsiveImages;
    fs.writeFileSync(
      validationPath,
      await format(JSON.stringify(validation), { parser: 'json' }),
    );
    console.log(JSON.stringify(responsiveImages, null, 2));
  } finally {
    await browser.close();
  }
}
