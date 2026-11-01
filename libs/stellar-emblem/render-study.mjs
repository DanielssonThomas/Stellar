import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

(async () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, 'assets/manifest.json'), 'utf8'),
  );
  const source = fs.readFileSync(
    path.join(root, 'assets/stellar-emblem-study.svg'),
    'utf8',
  );
  const layerFiles = manifest.layers.map((layer) => ({
    ...layer,
    source: fs.readFileSync(path.join(root, 'assets', layer.file), 'utf8'),
  }));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1120, height: 780 },
    deviceScaleFactor: 1,
  });
  const validation = await page.evaluate(
    ({ source, layerFiles }) => {
      const parser = new DOMParser();
      const allowed = new Set([
        'svg',
        'title',
        'defs',
        'linearGradient',
        'stop',
        'g',
        'path',
        'circle',
      ]);
      const documents = [
        source,
        ...layerFiles.map((layer) => layer.source),
      ].map((text) => parser.parseFromString(text, 'image/svg+xml'));
      for (const doc of documents) {
        if (doc.doctype || doc.querySelector('parsererror'))
          throw new Error('Invalid SVG');
        if (doc.documentElement.getAttribute('viewBox') !== '0 0 512 512')
          throw new Error('Inconsistent viewBox');
        for (const node of doc.querySelectorAll('*')) {
          if (!allowed.has(node.localName))
            throw new Error(`Unsupported SVG node ${node.localName}`);
          for (const attr of node.attributes) {
            if (/^on/i.test(attr.name) || /href|src/i.test(attr.name))
              throw new Error('Active SVG attribute');
            if (
              /url\(/i.test(attr.value) &&
              !/^url\(#[a-zA-Z][\w-]*\)$/.test(attr.value)
            )
              throw new Error('External SVG reference');
          }
        }
      }
      for (let index = 0; index < layerFiles.length; index += 1) {
        if (!documents[index + 1].getElementById(layerFiles[index].id))
          throw new Error('Missing layer ID');
      }
      return {
        documents: documents.length,
        layerIds: layerFiles.map((layer) => layer.id),
        activeContent: false,
      };
    },
    { source, layerFiles },
  );
  const exploded = await page.evaluate(
    ({ source, manifest }) => {
      const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
      doc.documentElement.setAttribute('viewBox', '-160 -160 832 832');
      for (const layer of manifest.layers) {
        const node = doc.getElementById(layer.id);
        const pose = layer.exploded;
        node.setAttribute(
          'transform',
          `translate(${pose.x} ${pose.y}) rotate(${pose.rotation} ${layer.anchor.x} ${layer.anchor.y})`,
        );
      }
      return new XMLSerializer().serializeToString(doc.documentElement);
    },
    { source, manifest },
  );
  const cell = (label, svg, size) =>
    `<section><h2>${label}</h2><div style="width:${size}px;height:${size}px">${svg}</div></section>`;
  await page.setContent(
    `<style>body{margin:24px;background:#08070d;color:#ded4ef;font:14px system-ui}h1{font-size:20px}h2{font-size:13px;font-weight:400}main{display:flex;gap:32px;align-items:center}footer{display:flex;gap:56px;align-items:center}svg{width:100%;height:100%}</style><h1>Stellar layer study — unapproved artwork</h1><main>${cell('Assembled · 512 px', source, 512)}${cell('Exploded · 512 px', exploded, 512)}</main><footer>${[48, 64, 96].map((size) => cell(`${size} px`, source, size)).join('')}<p>Faces and hair detail need substantial refinement.<br>This study cannot satisfy final-art acceptance.</p></footer>`,
  );
  fs.mkdirSync(path.join(root, 'fixtures'), { recursive: true });
  await page.screenshot({
    path: path.join(root, 'fixtures/study-contact-sheet.png'),
    fullPage: true,
  });
  const runtimeBytes =
    Buffer.byteLength(source) +
    Buffer.byteLength(JSON.stringify(manifest)) +
    layerFiles.reduce(
      (total, layer) => total + Buffer.byteLength(layer.source),
      0,
    );
  if (runtimeBytes > 100 * 1024)
    throw new Error('Study exceeds runtime source budget');
  fs.writeFileSync(
    path.join(root, 'fixtures/validation.json'),
    JSON.stringify(
      {
        status: 'unapproved-study',
        ...validation,
        runtimeBytes,
        budgetBytes: 102400,
      },
      null,
      2,
    ) + '\n',
  );
  await browser.close();
  console.log(
    JSON.stringify({
      runtimeBytes,
      validatedDocuments: validation.documents,
      fixture: 'study-contact-sheet.png',
    }),
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
