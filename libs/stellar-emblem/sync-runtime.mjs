import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const { format } = createRequire(import.meta.url)('prettier');

const source = path.join(import.meta.dirname, 'production-v1');
const destination = path.resolve(
  import.meta.dirname,
  '../../apps/stellar-desktop/public/emblem',
);
const manifest = JSON.parse(
  fs.readFileSync(path.join(source, 'manifest.json'), 'utf8'),
);
const images = [
  ...new Set(
    manifest.layers.flatMap((layer) => [
      layer.file,
      ...(layer.assembly ? [layer.assembly.file] : []),
    ]),
  ),
];
const files = [
  'manifest.json',
  ...images,
  ...manifest.rasterSizes.flatMap((width) =>
    images
      .filter((file) => file.endsWith('.png'))
      .map((file) => `resolutions/${width}/${file}`),
  ),
];
const rows = files.map((file) => {
  const content = fs.readFileSync(path.join(source, file));
  const target = path.join(destination, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  if (!content.equals(fs.readFileSync(target)))
    throw new Error(`Runtime copy differs: ${file}`);
  const normalized = /\.(json|svg)$/.test(file)
    ? Buffer.from(content.toString('utf8').replaceAll('\r\n', '\n'))
    : content;
  return `| ${file} | ${createHash('sha256').update(normalized).digest('hex')} |`;
});
const provenance = path.join(destination, 'provenance.md');
let introduction = fs
  .readFileSync(provenance, 'utf8')
  .split(/^\| Runtime file\s*\|/m)[0];
introduction = introduction.replace(
  /The experimental runtime payload is[^\r\n]+/,
  'The responsive pack includes 128, 256, 512, 768 and 1024-pixel PNG variants plus untouched 1280-pixel originals. The component supplies its measured container width through sizes/srcset, so the browser accounts for display density. Assembled originals use the same resolution choices; SVG rings stay vector. Each resolution tier retains the 8 MiB runtime budget, and the complete embedded distribution has a 16 MiB budget. Exact byte counts are recorded in source previews/validation.json. Browsers may retain a larger cached candidate after shrinking. Native appearance/performance remains separate verification; this pack is an experimental candidate.',
);
fs.writeFileSync(
  provenance,
  await format(
    `${introduction}| Runtime file | SHA-256 |\n| --- | --- |\n${rows.join('\n')}\n`,
    { parser: 'markdown' },
  ),
);
console.log(`Copied and verified ${files.length} source/runtime files`);
