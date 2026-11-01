import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { digest, requireValue } from './planning-evidence.mjs';

const recordName = /^[a-z0-9.-]{1,180}$/;
const maxBytes = 256 * 1024;

export async function openHostStore(root) {
  requireValue(
    path.isAbsolute(root),
    'Host storage requires an absolute path.',
  );
  await mkdir(root, { recursive: true, mode: 0o700 });
  const canonical = await realpath(root);
  const expected = path.resolve(root);
  requireValue(
    process.platform === 'win32'
      ? canonical.toLowerCase() === expected.toLowerCase()
      : canonical === expected,
    'Host storage cannot use a linked directory.',
  );
  async function file(name) {
    requireValue(
      typeof name === 'string' &&
        recordName.test(name) &&
        name !== '.' &&
        name !== '..' &&
        !name.endsWith('.') &&
        !name.endsWith('.guard'),
      'Invalid host record name.',
    );
    requireValue(
      (await realpath(root)) === canonical,
      'Host storage identity changed.',
    );
    return path.join(canonical, name);
  }
  async function read(name, expectedDigest) {
    const target = await file(name);
    const info = await lstat(target, { bigint: true });
    requireValue(
      info.isFile() &&
        !info.isSymbolicLink() &&
        info.nlink === 1n &&
        info.size <= BigInt(maxBytes),
      'Host record is unsafe or oversized.',
    );
    const handle = await open(target, 'r');
    let envelope;
    try {
      const current = await handle.stat({ bigint: true });
      // Windows path metadata can report device zero while the open handle has its volume ID.
      const sameDevice =
        current.dev === info.dev ||
        (process.platform === 'win32' && info.dev === 0n);
      requireValue(
        current.ino === info.ino &&
          sameDevice &&
          current.nlink === 1n &&
          current.size <= BigInt(maxBytes),
        'Host record changed while opening.',
      );
      const buffer = Buffer.alloc(maxBytes + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      requireValue(
        bytesRead <= maxBytes && BigInt(bytesRead) === current.size,
        'Host record exceeds its byte bound or changed.',
      );
      envelope = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(
          buffer.subarray(0, bytesRead),
        ),
      );
    } finally {
      await handle.close();
    }
    requireValue(
      envelope.digest === digest(envelope.value) &&
        (!expectedDigest || envelope.digest === expectedDigest),
      'Host record integrity mismatch.',
    );
    return JSON.parse(JSON.stringify(envelope));
  }
  async function mutate(name, action) {
    const guardPath = `${await file(name)}.guard`;
    const guard = await open(guardPath, 'wx', 0o600);
    try {
      return await action();
    } finally {
      await guard.close();
      await unlink(guardPath);
    }
  }
  async function create(name, value) {
    const envelope = { value, digest: digest(value) };
    const bytes = Buffer.from(`${JSON.stringify(envelope)}\n`);
    requireValue(
      bytes.length <= maxBytes,
      'Host record exceeds its byte bound.',
    );
    await mutate(name, async () => {
      const handle = await open(await file(name), 'wx', 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
    return JSON.parse(bytes.toString('utf8'));
  }
  async function exists(name) {
    try {
      await read(name);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }
  async function release(name, expectedDigest) {
    requireValue(
      typeof expectedDigest === 'string' &&
        /^[a-f0-9]{64}$/.test(expectedDigest),
      'Release requires a pinned record digest.',
    );
    await mutate(name, async () => {
      await read(name, expectedDigest);
      await unlink(await file(name));
    });
  }
  return Object.freeze({ root: canonical, create, read, exists, release });
}
