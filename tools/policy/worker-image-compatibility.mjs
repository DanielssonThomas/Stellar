import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const embeddedMeteringProxyPath = '/opt/stellar-peon-metering-proxy.mjs';

const workerImagePattern =
  /^ghcr\.io\/stellar-ai-corp\/hermes-worker@sha256:[a-f0-9]{64}$/;

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function parseInspection(stdout) {
  const output = String(stdout ?? '').trim();
  const match = output.match(
    /^([a-f0-9]{64})\s+\/opt\/stellar-peon-metering-proxy\.mjs$/,
  );
  return match?.[1] ?? null;
}

export function buildWorkerImageInspectionArgs(image) {
  if (!workerImagePattern.test(image ?? ''))
    throw new Error(
      'Worker image must be the authorized GHCR repository pinned by a lowercase SHA-256 digest.',
    );
  return [
    'run',
    '--rm',
    '--pull=never',
    '--network=none',
    '--read-only',
    '--cap-drop=all',
    '--security-opt=no-new-privileges',
    '--pids-limit=8',
    '--memory=64m',
    '--memory-swap=64m',
    '--cpus=1',
    '--entrypoint=/usr/bin/sha256sum',
    image,
    embeddedMeteringProxyPath,
  ];
}

export async function verifyWorkerImageCompatibility({
  image,
  sourcePath,
  inspectImage,
  readTrustedSource = readFile,
}) {
  if (!workerImagePattern.test(image ?? ''))
    throw new Error(
      'Worker image must be the authorized GHCR repository pinned by a lowercase SHA-256 digest.',
    );
  if (!path.isAbsolute(sourcePath ?? ''))
    throw new Error('Trusted metering proxy source path must be absolute.');
  if (typeof inspectImage !== 'function')
    throw new Error('Trusted worker image inspection is unavailable.');

  let expectedSha256;
  try {
    expectedSha256 = sha256(await readTrustedSource(sourcePath));
  } catch {
    throw new Error(
      'Trusted metering proxy source could not be read; refusing to launch Peon.',
    );
  }

  let inspection;
  try {
    inspection = await inspectImage(image, embeddedMeteringProxyPath);
  } catch {
    throw new Error(
      `Could not inspect ${embeddedMeteringProxyPath} in the pinned worker image. Confirm that this exact digest is locally available and contains the proxy file; refusing to launch Peon.`,
    );
  }
  const actualSha256 =
    inspection?.status === 0 ? parseInspection(inspection.stdout) : null;
  if (!actualSha256)
    throw new Error(
      `Could not inspect ${embeddedMeteringProxyPath} in the pinned worker image. Confirm that this exact digest is locally available and contains the proxy file; refusing to launch Peon.`,
    );

  if (actualSha256 !== expectedSha256)
    throw new Error(
      `Pinned worker image is incompatible: embedded metering proxy SHA-256 ${actualSha256} differs from trusted source ${expectedSha256}. Rebuild from current develop and obtain authorization before publishing or promoting its immutable digest.`,
    );

  return { image, sourceSha256: expectedSha256, imageSha256: actualSha256 };
}
