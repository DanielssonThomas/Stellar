import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)('@playwright/test');
const { format } = createRequire(import.meta.url)('prettier');
const root = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'production-v1',
);
const registration = JSON.parse(
  fs.readFileSync(path.join(root, 'registration.json'), 'utf8'),
);
const size = registration.canvas;
if (size !== 1280) throw new Error('Production canvas must be 1280 square');
const svg = (id, content) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="1280" viewBox="0 0 1280 1280"><defs><linearGradient id="gold" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#fff6a1"/><stop offset=".24" stop-color="#ffcf4e"/><stop offset=".5" stop-color="#a95708"/><stop offset=".73" stop-color="#ffe890"/><stop offset="1" stop-color="#d87e13"/></linearGradient></defs><g id="${id}">${content}</g></svg>`;
const geometries = [
  {
    id: 'outer-frame',
    content:
      '<circle cx="640" cy="640" r="510" fill="none" stroke="#603105" stroke-width="25"/><circle cx="640" cy="640" r="510" fill="none" stroke="url(#gold)" stroke-width="19"/><circle cx="640" cy="640" r="518" fill="none" stroke="#ffe77d" stroke-width="2"/><circle cx="640" cy="640" r="502" fill="none" stroke="#ffbd32" stroke-width="2"/>',
    anchor: [640, 640],
    exploded: [-28, 0, -2],
  },
  {
    id: 'inner-circle',
    content:
      '<circle cx="640" cy="640" r="478" fill="none" stroke="#5f3309" stroke-width="8"/><circle cx="640" cy="640" r="478" fill="none" stroke="url(#gold)" stroke-width="5"/>',
    anchor: [640, 640],
    exploded: [28, 0, 2],
  },
  ...[
    ['north', 640, 130],
    ['east', 1150, 640],
    ['south', 640, 1150],
    ['west', 130, 640],
  ].map(([direction, x, y]) => ({
    id: `cardinal-${direction}`,
    anchor: [x, y],
    exploded: [(x - 640) * 0.12, (y - 640) * 0.12, 0],
    content: `<g transform="translate(${x} ${y})"><path d="M0 -58 Q10 -10 44 0 Q10 10 0 58 Q-10 10 -44 0 Q-10 -10 0 -58Z" fill="url(#gold)" stroke="#75410c" stroke-width="4"/><path d="M0 -50 0 0 -37 0 Q-9 -9 0 -50" fill="#fff4a0"/><path d="M0 0 37 0 Q9 9 0 50Z" fill="#ffb319"/><path d="M0 -50V50M-37 0H37" stroke="#fff1a0" stroke-width="1.5"/></g>`,
  })),
];
const explodedPose = (id) => {
  const character = id.startsWith('gold') || id.startsWith('violet');
  const separation =
    900 + (id.endsWith('hair') ? 60 : id.endsWith('ornament') ? 120 : 0);
  const depth =
    id === 'violet-ornament'
      ? -780
      : character
        ? separation * (id.startsWith('gold') ? 1 : -1)
        : id === 'outer-frame'
          ? 180
          : id === 'inner-circle'
            ? -180
            : 0;
  return { x: 0, y: 0, rotation: 0, depth };
};
const zero = { x: 0, y: 0, rotation: 0 };
const entry = (item, z, extension) => ({
  id: item.id,
  file: `layers/${item.id}.${extension}`,
  z,
  anchor: { x: item.anchor[0], y: item.anchor[1] },
  assembled: zero,
  exploded: explodedPose(item.id),
  ...(item.id === 'outer-frame'
    ? { spin: 'clockwise' }
    : item.id === 'inner-circle'
      ? { spin: 'counter-clockwise' }
      : {}),
});
const manifest = {
  version: 1,
  status: 'production-candidate',
  viewBox: [0, 0, size, size],
  layers: [
    ...registration.layers.map((item, z) => entry(item, z, 'png')),
    ...geometries.map((item, z) =>
      entry(item, z + registration.layers.length, 'svg'),
    ),
  ],
};
fs.mkdirSync(path.join(root, 'layers'), { recursive: true });
fs.mkdirSync(path.join(root, 'previews'), { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 900 },
    deviceScaleFactor: 1,
  });
  for (const item of geometries) {
    const source = svg(item.id, item.content);
    await page.evaluate((source) => {
      const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
      if (doc.doctype || doc.querySelector('parsererror'))
        throw new Error('Malformed SVG');
      const allowed = new Set([
        'svg',
        'defs',
        'linearGradient',
        'stop',
        'g',
        'circle',
        'path',
      ]);
      const attrs = new Set([
        'xmlns',
        'width',
        'height',
        'viewBox',
        'id',
        'x1',
        'x2',
        'y1',
        'y2',
        'stop-color',
        'offset',
        'cx',
        'cy',
        'r',
        'fill',
        'stroke',
        'stroke-width',
        'transform',
        'd',
      ]);
      for (const node of doc.querySelectorAll('*')) {
        if (!allowed.has(node.localName)) throw new Error('Unsafe SVG element');
        for (const attr of node.attributes) {
          if (!attrs.has(attr.name)) throw new Error('Unsafe SVG attribute');
          if (/url\(/i.test(attr.value) && attr.value !== 'url(#gold)')
            throw new Error('External SVG reference');
        }
      }
    }, source);
    fs.writeFileSync(
      path.join(root, 'layers', `${item.id}.svg`),
      source + '\n',
    );
  }
  const alpha = [];
  for (const item of registration.layers) {
    if (
      !/^[a-z-]+$/.test(item.id) ||
      !Number.isFinite(item.scale) ||
      item.scale <= 0 ||
      ![item.x, item.y].every(Number.isFinite)
    )
      throw new Error('Invalid registration');
    const input = fs.readFileSync(
      path.join(root, 'sources', `${item.id}-generated.png`),
    );
    const result = await page.evaluate(
      async ({ src, item, size }) => {
        const image = new Image();
        image.src = src;
        await image.decode();
        if (image.naturalWidth !== 1254 || image.naturalHeight !== 1254)
          throw new Error('Raster source dimensions differ');
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = image.naturalWidth;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(image, 0, 0);
        const sourcePixels = ctx.getImageData(
          0,
          0,
          image.naturalWidth,
          image.naturalHeight,
        ).data;
        let transparent = 0,
          opaque = 0,
          partial = 0;
        for (let i = 3; i < sourcePixels.length; i += 4) {
          const a = sourcePixels[i];
          if (a === 0) transparent++;
          else if (a === 255) opaque++;
          else partial++;
        }
        if (!transparent || !opaque || !partial)
          throw new Error('Expected genuine transparent antialiased raster');
        canvas.width = canvas.height = size;
        ctx.drawImage(
          image,
          item.x,
          item.y,
          size * item.scale,
          size * item.scale,
        );
        const final = ctx.getImageData(0, 0, size, size).data;
        let finalTransparent = 0,
          finalVisible = 0;
        for (let i = 3; i < final.length; i += 4) {
          if (final[i] === 0) finalTransparent++;
          else finalVisible++;
        }
        if (!finalTransparent || !finalVisible)
          throw new Error('Export lost artwork or transparent background');
        for (let p = 0; p < size; p++)
          for (const i of [
            p,
            (size - 1) * size + p,
            p * size,
            p * size + size - 1,
          ])
            if (final[i * 4 + 3] !== 0)
              throw new Error('Registered artwork touches export edge');
        return {
          png: canvas.toDataURL('image/png').split(',')[1],
          sourceWidth: image.naturalWidth,
          sourceHeight: image.naturalHeight,
          transparent,
          opaque,
          partial,
          finalTransparent,
          finalVisible,
        };
      },
      { src: `data:image/png;base64,${input.toString('base64')}`, item, size },
    );
    fs.writeFileSync(
      path.join(root, 'layers', `${item.id}.png`),
      Buffer.from(result.png, 'base64'),
    );
    alpha.push({
      id: item.id,
      width: size,
      height: size,
      sourceWidth: result.sourceWidth,
      sourceHeight: result.sourceHeight,
      sourceAlpha: {
        transparent: result.transparent,
        opaque: result.opaque,
        partial: result.partial,
      },
      exportAlpha: {
        transparent: result.finalTransparent,
        visible: result.finalVisible,
      },
    });
  }
  fs.writeFileSync(
    path.join(root, 'manifest.json'),
    await format(JSON.stringify(manifest), { parser: 'json' }),
  );
  const layers = manifest.layers.map((layer) => {
    if (
      !/^layers\/[a-z-]+\.(png|svg)$/.test(layer.file) ||
      layer.assembled.x ||
      layer.assembled.y ||
      layer.assembled.rotation
    )
      throw new Error('Unsafe path or nonzero assembly');
    const data = fs.readFileSync(path.join(root, layer.file));
    return {
      ...layer,
      src: `data:image/${layer.file.endsWith('.svg') ? 'svg+xml' : 'png'};base64,${data.toString('base64')}`,
    };
  });
  const renders = await page.evaluate(
    async ({ layers, size }) => {
      const images = await Promise.all(
        layers.map(async (layer) => {
          const img = new Image();
          img.src = layer.src;
          await img.decode();
          return { layer, img };
        }),
      );
      const render = (dimension, exploded, applyAssembled = false) => {
        const c = document.createElement('canvas');
        c.width = c.height = dimension;
        const ctx = c.getContext('2d');
        const margin = exploded ? 90 : 0;
        const scale = dimension / (size + 2 * margin);
        ctx.scale(scale, scale);
        ctx.translate(margin, margin);
        for (const { layer, img } of images) {
          ctx.save();
          if (exploded || applyAssembled) {
            const p = exploded ? layer.exploded : layer.assembled,
              a = layer.anchor;
            ctx.translate(p.x + a.x, p.y + a.y);
            ctx.rotate((p.rotation * Math.PI) / 180);
            ctx.translate(-a.x, -a.y);
          }
          ctx.drawImage(img, 0, 0, size, size);
          ctx.restore();
        }
        return {
          url: c.toDataURL('image/png'),
          pixels: ctx.getImageData(0, 0, dimension, dimension).data,
        };
      };
      const canonical = render(size, false);
      const duplicate = render(size, false, true);
      if (!canonical.pixels.every((byte, i) => byte === duplicate.pixels[i]))
        throw new Error('Zero-pose assembly differs');
      return {
        canonical: canonical.url,
        assembled512: render(512, false).url,
        exploded512: render(512, true).url,
        dock48: render(48, false).url,
        dock64: render(64, false).url,
        dock96: render(96, false).url,
      };
    },
    { layers, size },
  );
  for (const [name, url] of Object.entries(renders))
    fs.writeFileSync(
      path.join(root, 'previews', `${name}.png`),
      Buffer.from(url.split(',')[1], 'base64'),
    );
  await page.setContent(
    `<style>body{margin:24px;background:#0b0812;color:#ede1fa;font:14px system-ui}h1{font-size:20px}main,footer{display:flex;gap:28px;align-items:center}h2{font-size:14px;font-weight:400}img{display:block}footer{margin-top:24px}</style><h1>Stellar production candidate v1 — registered hybrid layers</h1><main><section><h2>Canonical assembled · 512 px</h2><img src="${renders.assembled512}"></section><section><h2>Exploded · 512 px</h2><img src="${renders.exploded512}"></section></main><footer>${[48, 64, 96].map((n) => `<section><h2>${n} px</h2><img src="${renders['dock' + n]}"></section>`).join('')}<p>12 independently compositable layers.<br>Profiles and colour masses survive at 48 px;<br>leaf facets and individual strands need larger sizes.</p></footer>`,
  );
  await page.screenshot({
    path: path.join(root, 'previews', 'contact-sheet.png'),
    fullPage: true,
  });
  await page.setContent(
    `<style>body{margin:24px;background:#0b0812;color:#ede1fa;font:14px system-ui}main{display:grid;grid-template-columns:repeat(4,270px);gap:12px}figure{margin:0}img{width:250px;height:250px}figcaption{font-size:13px}</style><h1>Independent registered layers · 1280 square canvases</h1><main>${layers.map((layer) => `<figure><img src="${layer.src}"><figcaption>${layer.id} · z=${layer.z}</figcaption></figure>`).join('')}</main>`,
  );
  await page.screenshot({
    path: path.join(root, 'previews', 'layer-contact-sheet.png'),
    fullPage: true,
  });
  const bytes =
    fs.statSync(path.join(root, 'manifest.json')).size +
    manifest.layers.reduce(
      (sum, l) => sum + fs.statSync(path.join(root, l.file)).size,
      0,
    );
  const budget = 4 * 1024 * 1024;
  if (bytes > budget) throw new Error(`Runtime byte budget exceeded: ${bytes}`);
  const validation = {
    canvas: size,
    layers: layers.length,
    rasterLayers: alpha,
    svgLayers: geometries.length,
    zeroPose:
      'All manifest poses are zero; canonical pixels are a deterministic composition of these exact registered files.',
    runtimeBytes: bytes,
    budgetBytes: budget,
    activeSvgContent: false,
  };
  fs.writeFileSync(
    path.join(root, 'previews', 'validation.json'),
    JSON.stringify(validation, null, 2) + '\n',
  );
  console.log(JSON.stringify(validation, null, 2));
} finally {
  await browser.close();
}
