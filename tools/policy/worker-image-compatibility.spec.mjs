import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  buildWorkerImageInspectionArgs,
  embeddedMeteringProxyPath,
  verifyWorkerImageCompatibility,
} from './worker-image-compatibility.mjs';

const image = `ghcr.io/stellar-ai-corp/hermes-worker@sha256:${'a'.repeat(64)}`;
const root = await mkdtemp(join(tmpdir(), 'stellar-image-compatibility-'));
const sourcePath = join(root, 'peon-metering-proxy.mjs');
const source = 'trusted metering proxy source';
const sourceSha256 = createHash('sha256').update(source).digest('hex');
const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

await writeFile(sourcePath, source);

function inspection(stdout, status = 0) {
  return async () => ({ status, stdout });
}

test('accepts matching trusted source and embedded image hashes', async () => {
  let inspectedImage;
  let inspectedPath;
  const result = await verifyWorkerImageCompatibility({
    image,
    sourcePath,
    inspectImage: async (selectedImage, filePath) => {
      inspectedImage = selectedImage;
      inspectedPath = filePath;
      return {
        status: 0,
        stdout: `${sourceSha256}  ${embeddedMeteringProxyPath}\n`,
      };
    },
  });

  assert.deepEqual(result, {
    image,
    sourceSha256,
    imageSha256: sourceSha256,
  });
  assert.equal(inspectedImage, image);
  assert.equal(inspectedPath, embeddedMeteringProxyPath);
});

test('rejects a mismatched proxy hash with sanitized rebuild guidance', async () => {
  await assert.rejects(
    verifyWorkerImageCompatibility({
      image,
      sourcePath,
      inspectImage: inspection(
        `${'b'.repeat(64)}  ${embeddedMeteringProxyPath}\n`,
      ),
    }),
    (error) => {
      assert.match(error.message, /Pinned worker image is incompatible/);
      assert.match(error.message, /Rebuild from current develop/);
      assert.match(error.message, new RegExp(sourceSha256));
      return true;
    },
  );
});

test('preserves exact LF bytes for the trusted proxy checkout on Windows', () => {
  const attributes = readFileSync(
    join(repositoryRoot, '.gitattributes'),
    'utf8',
  );
  const proxyBytes = readFileSync(
    new URL('./peon-metering-proxy.mjs', import.meta.url),
  );
  const checkedAttributes = execFileSync(
    'git',
    ['check-attr', 'text', 'eol', '--', 'tools/policy/peon-metering-proxy.mjs'],
    { cwd: repositoryRoot, encoding: 'utf8' },
  );

  assert.match(
    attributes,
    /^\/tools\/policy\/peon-metering-proxy\.mjs text eol=lf$/m,
  );
  assert.match(checkedAttributes, /text: set/);
  assert.match(checkedAttributes, /eol: lf/);
  assert.equal(proxyBytes.includes(0x0d), false);
});

test('preserves exact LF bytes for the trusted prompt-inspection shell checkout on Windows', () => {
  const attributes = readFileSync(
    join(repositoryRoot, '.gitattributes'),
    'utf8',
  );
  const inspectionBytes = readFileSync(
    join(repositoryRoot, 'tools/policy/run-hermes-system-prompt-inspection.sh'),
  );
  const checkedAttributes = execFileSync(
    'git',
    [
      'check-attr',
      'text',
      'eol',
      '--',
      'tools/policy/run-hermes-system-prompt-inspection.sh',
    ],
    { cwd: repositoryRoot, encoding: 'utf8' },
  );

  assert.match(
    attributes,
    /^\/tools\/policy\/run-hermes-system-prompt-inspection\.sh text eol=lf$/m,
  );
  assert.match(checkedAttributes, /text: set/);
  assert.match(checkedAttributes, /eol: lf/);
  assert.equal(inspectionBytes.includes(0x0d), false);
  assert.equal(
    inspectionBytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])),
    false,
  );
});

test('does not normalize CRLF trusted source to match an LF image', async () => {
  const crlfPath = `${sourcePath}.crlf`;
  const crlfSource = `${source}\r\n`;
  const crlfSha256 = createHash('sha256').update(crlfSource).digest('hex');
  await writeFile(crlfPath, crlfSource);

  await assert.rejects(
    verifyWorkerImageCompatibility({
      image,
      sourcePath: crlfPath,
      inspectImage: inspection(
        `${sourceSha256}  ${embeddedMeteringProxyPath}\n`,
      ),
    }),
    (error) => {
      assert.match(error.message, /Pinned worker image is incompatible/);
      assert.match(
        error.message,
        new RegExp(`embedded metering proxy SHA-256 ${sourceSha256}`),
      );
      assert.match(
        error.message,
        new RegExp(`differs from trusted source ${crlfSha256}`),
      );
      assert.match(error.message, new RegExp(crlfSha256));
      return true;
    },
  );
});

test('rejects a missing local image without exposing Podman diagnostics', async () => {
  await assert.rejects(
    verifyWorkerImageCompatibility({
      image,
      sourcePath,
      inspectImage: async () => ({
        status: 125,
        stdout: '',
        stderr: 'private token=do-not-print',
      }),
    }),
    (error) => {
      assert.match(error.message, /exact digest is locally available/);
      assert.doesNotMatch(error.message, /private token|do-not-print/);
      return true;
    },
  );
});

test('rejects a missing embedded proxy file', async () => {
  await assert.rejects(
    verifyWorkerImageCompatibility({
      image,
      sourcePath,
      inspectImage: inspection('', 1),
    }),
    /contains the proxy file; refusing to launch Peon/,
  );
});

test('rejects inspection failures without exposing raw error text', async () => {
  await assert.rejects(
    verifyWorkerImageCompatibility({
      image,
      sourcePath,
      inspectImage: async () => {
        throw new Error('Authorization: Bearer sensitive-value');
      },
    }),
    (error) => {
      assert.match(error.message, /Could not inspect/);
      assert.doesNotMatch(error.message, /sensitive-value|Authorization/);
      return true;
    },
  );
});

test('rejects malformed image inspection output', async () => {
  await assert.rejects(
    verifyWorkerImageCompatibility({
      image,
      sourcePath,
      inspectImage: inspection(`${sourceSha256}  /tmp/other-file`),
    }),
    /Could not inspect/,
  );
});

test('rejects invalid, mutable, and untrusted image references before inspection', async () => {
  let inspected = false;
  const inspectImage = async () => {
    inspected = true;
    return {
      status: 0,
      stdout: `${sourceSha256}  ${embeddedMeteringProxyPath}`,
    };
  };

  for (const invalidImage of [
    'ghcr.io/stellar-ai-corp/hermes-worker:latest',
    `ghcr.io/stellar-ai-corp/other@sha256:${'a'.repeat(64)}`,
    `ghcr.io/stellar-ai-corp/hermes-worker@sha256:${'A'.repeat(64)}`,
  ]) {
    await assert.rejects(
      verifyWorkerImageCompatibility({
        image: invalidImage,
        sourcePath,
        inspectImage,
      }),
      /authorized GHCR repository pinned by a lowercase SHA-256 digest/,
    );
  }
  assert.equal(inspected, false);
});

test('inspects offline and read-only without capabilities or credentials', () => {
  const args = buildWorkerImageInspectionArgs(image);

  assert.ok(args.includes('--pull=never'));
  assert.ok(args.includes('--network=none'));
  assert.ok(args.includes('--read-only'));
  assert.ok(args.includes('--cap-drop=all'));
  assert.ok(args.includes('--security-opt=no-new-privileges'));
  assert.ok(args.includes('--entrypoint=/usr/bin/sha256sum'));
  assert.deepEqual(args.slice(-2), [image, embeddedMeteringProxyPath]);
  assert.equal(
    args.some((argument) =>
      /GH_TOKEN|STELLAR_INTEGRATION_TOKEN|secret|18436|http:\/\/peon-meter/i.test(
        argument,
      ),
    ),
    false,
  );
});

test.after(async () => rm(root, { recursive: true, force: true }));
