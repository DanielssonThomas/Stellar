// Offline packaging proof only. Does not launch the candidate or contact a runtime.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { brotliDecompressSync } from 'node:zlib';

const [out, dependencyFile] = process.argv.slice(2);
const sha = (value) => createHash('sha256').update(value).digest('hex');
const renderer = JSON.parse(
  readFileSync(path.join(out, 'renderer-assets.json')),
);
const binaryRecord = JSON.parse(readFileSync(path.join(out, 'binary.json')));
const binary = readFileSync(binaryRecord.path);
assert.equal(sha(binary), binaryRecord.sha256);
const dependencies = readFileSync(dependencyFile, 'utf8');
const paths = [
  ...new Set(
    [
      ...dependencies.matchAll(
        /[A-Za-z]:[\\/][^ \r\n]*tauri-codegen-assets[^ \r\n]*/g,
      ),
    ].map((match) => match[0].replace(/:$/, '')),
  ),
];
assert(paths.length > 0, 'No actual Tauri embedded-asset dependencies');
const decoded = [];
for (const file of paths) {
  const stored = readFileSync(file);
  assert(binary.includes(stored), `Asset not in retained executable: ${file}`);
  let raw = stored;
  try {
    raw = brotliDecompressSync(stored);
  } catch {
    /* compression feature can be off */
  }
  decoded.push({ file, storedSha256: sha(stored), rawSha256: sha(raw), raw });
}
for (const [name, expected] of Object.entries(renderer)) {
  const input = readFileSync(
    path.join(out, 'stellar/dist/apps/stellar-desktop/browser', name),
  );
  assert.equal(sha(input), expected, `Renderer changed: ${name}`);
  if (name !== 'index.html')
    assert(
      decoded.some((asset) => asset.rawSha256 === expected),
      `Missing current renderer asset: ${name}`,
    );
}
const index = readFileSync(
  path.join(out, 'stellar/dist/apps/stellar-desktop/browser/index.html'),
  'utf8',
);
const scripts = [...index.matchAll(/src="([^"]+\.js)"/g)].map(
  (match) => match[1],
);
assert(scripts.length > 0);
assert(
  decoded.some(
    ({ raw }) =>
      scripts.every((script) => raw.includes(Buffer.from(script))) &&
      raw.includes(Buffer.from('<html')),
  ),
  'Embedded HTML does not reference current script assets',
);
assert(
  decoded.some(({ raw }) => raw.includes(Buffer.from('Delivery diagnostics'))),
  'New diagnostics UI missing from embedded renderer',
);
const report = {
  dependencyFile,
  dependencySha256: sha(readFileSync(dependencyFile)),
  rendererManifestSha256: sha(
    readFileSync(path.join(out, 'renderer-assets.json')),
  ),
  binarySha256: binaryRecord.sha256,
  rendererFiles: Object.keys(renderer).length,
  actualEmbeddedAssets: decoded.length,
  scriptReferences: scripts,
  verified: true,
  launched: false,
  verifierSha256: sha(readFileSync(new URL(import.meta.url))),
  assets: decoded.map(({ raw, ...metadata }) => metadata),
};
writeFileSync(
  path.join(out, 'embedded-renderer.json'),
  JSON.stringify(report, null, 2) + '\n',
);
console.log(
  JSON.stringify({
    verified: true,
    rendererFiles: report.rendererFiles,
    embeddedAssets: decoded.length,
    binarySha256: report.binarySha256,
  }),
);
