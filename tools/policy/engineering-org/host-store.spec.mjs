import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  link,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openHostStore } from './host-store.mjs';
import { digest } from './planning-evidence.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'stellar-host-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, store: await openHostStore(root) };
}

test('persists UTF8 facts, preserves exclusive creation and releases only the pinned record', async (t) => {
  const { root, store } = await fixture(t);
  const value = {
    attempt: 'first',
    title: '星の状態',
    nested: { status: 'reserved' },
  };
  const envelope = await store.create('lease.json', value);
  assert.deepEqual(await store.read('lease.json', envelope.digest), envelope);
  assert.equal(await store.exists('lease.json'), true);
  const original = await readFile(join(root, 'lease.json'));
  await assert.rejects(store.create('lease.json', { attempt: 'second' }), {
    code: 'EEXIST',
  });
  assert.deepEqual(await readFile(join(root, 'lease.json')), original);
  await assert.rejects(
    store.release('lease.json', 'a'.repeat(64)),
    /integrity/,
  );
  assert.equal(await store.exists('lease.json'), true);
  await store.release('lease.json', envelope.digest);
  assert.equal(await store.exists('lease.json'), false);
});

test('detaches created receipt values from caller-owned mutable objects', async (t) => {
  const { store } = await fixture(t);
  const value = { candidate: { digest: 'initial' } };
  const envelope = await store.create('candidate.json', value);
  value.candidate.digest = 'substituted';
  assert.equal(digest(envelope.value), envelope.digest);
  assert.equal(envelope.value.candidate.digest, 'initial');
  assert.equal(
    (await store.read('candidate.json', envelope.digest)).value.candidate
      .digest,
    'initial',
  );
});

test('requires an external digest to release a host reservation', async (t) => {
  const { store } = await fixture(t);
  await store.create('lease.json', { reserved: true });
  await assert.rejects(store.release('lease.json'), /digest/);
  await assert.rejects(store.release('lease.json', ''), /digest/);
  assert.equal(await store.exists('lease.json'), true);
});

test('retains uncertain mutation guards and cannot release a newer lease with an old pin', async (t) => {
  const { root, store } = await fixture(t);
  const first = await store.create('lease.json', { owner: 'first' });
  const guard = join(root, 'lease.json.guard');
  await writeFile(guard, 'interrupted host');
  await assert.rejects(store.release('lease.json', first.digest), {
    code: 'EEXIST',
  });
  await assert.rejects(store.create('lease.json', { owner: 'new-key' }), {
    code: 'EEXIST',
  });
  assert.equal(await readFile(guard, 'utf8'), 'interrupted host');
  assert.equal(
    (await store.read('lease.json', first.digest)).value.owner,
    'first',
  );
  await rm(guard);
  await store.release('lease.json', first.digest);
  const second = await store.create('lease.json', { owner: 'second' });
  await assert.rejects(store.release('lease.json', first.digest), /integrity/);
  assert.equal(
    (await store.read('lease.json', second.digest)).value.owner,
    'second',
  );
  await writeFile(join(root, 'unused.json.guard'), 'uncertain creation');
  await assert.rejects(store.create('unused.json', {}), { code: 'EEXIST' });
  assert.equal(await store.exists('unused.json'), false);
});

test('detects content tampering and replacement self-digests against the host-retained pin', async (t) => {
  const { root, store } = await fixture(t);
  const receipt = await store.create('report.json', { decision: 'failed' });
  const replacement = { decision: 'passed' };
  await writeFile(
    join(root, 'report.json'),
    JSON.stringify({ value: replacement, digest: receipt.digest }),
  );
  await assert.rejects(store.read('report.json'), /integrity/);
  await writeFile(
    join(root, 'report.json'),
    JSON.stringify({ value: replacement, digest: digest(replacement) }),
  );
  await assert.rejects(store.read('report.json', receipt.digest), /integrity/);
  await assert.rejects(
    store.release('report.json', receipt.digest),
    /integrity/,
  );
});

test('does not treat torn or oversized durable records as absent or retryable', async (t) => {
  const { root, store } = await fixture(t);
  const target = join(root, 'lease.json');
  await writeFile(target, '{"value":');
  await assert.rejects(store.exists('lease.json'), SyntaxError);
  await assert.rejects(store.create('lease.json', { retry: true }), {
    code: 'EEXIST',
  });
  await writeFile(target, 'x'.repeat(256 * 1024 + 1));
  await assert.rejects(store.read('lease.json'), /oversized/);
  await assert.rejects(
    store.create('too-large.json', { text: '界'.repeat(90000) }),
    /byte bound/,
  );
  assert.equal(await store.exists('too-large.json'), false);
});

test('rejects malformed names, relative roots and hard-linked records', async (t) => {
  const { root, store } = await fixture(t);
  await assert.rejects(openHostStore('relative'), /absolute/);
  for (const name of [
    '../escape',
    '/absolute',
    'sub/file',
    'sub\\file',
    'name:stream',
  ]) {
    await assert.rejects(store.create(name, {}), /record name/);
  }
  await store.create('original.json', { immutable: true });
  await link(join(root, 'original.json'), join(root, 'linked.json'));
  await assert.rejects(store.read('linked.json'), /unsafe/);
  await assert.rejects(store.read('original.json'), /unsafe/);
});

test(
  'rejects symlinked record files',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { root, store } = await fixture(t);
    await store.create('original.json', {});
    await symlink(join(root, 'original.json'), join(root, 'linked.json'));
    await assert.rejects(store.read('linked.json'), /unsafe/);
  },
);

test('rejects a store directory symlink whose name differs only by case', async (t) => {
  const { root } = await fixture(t);
  const directory = join(root, 'store');
  const alias = join(root, 'Store');
  await openHostStore(directory);
  try {
    await symlink(directory, alias, 'dir');
  } catch (error) {
    if (
      process.platform === 'win32' &&
      ['EEXIST', 'EPERM', 'EACCES'].includes(error.code)
    ) {
      t.skip('Windows cannot create this case-only directory symlink fixture.');
      return;
    }
    throw error;
  }
  await assert.rejects(openHostStore(alias), /linked directory/);
});

test('exactly one independent host process acquires the shared lease', async (t) => {
  const { root, store } = await fixture(t);
  const runner = join(root, 'race.mjs');
  await writeFile(
    runner,
    `import { openHostStore } from ${JSON.stringify(new URL('./host-store.mjs', import.meta.url).href)};
const store = await openHostStore(process.argv[2]);
process.send({ready:true});
process.once('message', async () => {
  try { const receipt = await store.create('shared-slot.json', { owner: process.argv[3] }); process.send({ won: true, digest: receipt.digest }); }
  catch (error) { process.send({ won: false, code: error.code }); }
  process.disconnect();
});`,
  );
  const children = ['first', 'second', 'third'].map((owner) =>
    spawn(process.execPath, [runner, root, owner], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    }),
  );
  t.after(() => children.forEach((child) => child.kill()));
  const results = children.map(
    (child) =>
      new Promise((resolve, reject) => {
        let response;
        child.on('error', reject);
        child.on('message', (message) => {
          if (Object.hasOwn(message, 'won')) response = message;
        });
        child.on('close', (code) =>
          code === 0 && response
            ? resolve(response)
            : reject(new Error(`Race child exited ${code}`)),
        );
      }),
  );
  await Promise.all(
    children.map(
      (child) =>
        new Promise((resolve, reject) => {
          child.once('message', resolve);
          child.once('error', reject);
        }),
    ),
  );
  children.forEach((child) => child.send({ start: true }));
  const outcomes = await Promise.all(results);
  assert.equal(outcomes.filter((result) => result.won).length, 1);
  assert.deepEqual(
    outcomes.filter((result) => !result.won).map((result) => result.code),
    ['EEXIST', 'EEXIST'],
  );
  const winner = outcomes.find((result) => result.won);
  assert.equal(
    (await store.read('shared-slot.json', winner.digest)).digest,
    winner.digest,
  );
  await assert.rejects(
    store.create('shared-slot.json', { owner: 'new-attempt-key' }),
    { code: 'EEXIST' },
  );
});
