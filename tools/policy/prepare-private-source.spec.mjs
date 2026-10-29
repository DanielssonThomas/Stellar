import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inspectRestrictedWorkspace } from './run-restricted-worker.mjs';
import { preparePrivateSourceCopy } from './prepare-private-source.mjs';

const helper = readFileSync(
  new URL('./copy-private-source.py', import.meta.url),
  'utf8',
);
const issueNumber = 143;
const branch = 'issue/143-capture';

function linuxPath(value) {
  if (process.platform !== 'win32') return value;
  return value
    .replace(/^([A-Za-z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`)
    .replaceAll('\\', '/');
}

function run(args, options = {}) {
  const windows = process.platform === 'win32';
  const result = spawnSync(
    windows ? 'wsl.exe' : args[0],
    windows ? ['--distribution', 'Ubuntu', '--exec', ...args] : args.slice(1),
    {
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 2 * 1024 * 1024,
      ...options,
    },
  );
  if (result.error || result.status !== 0)
    throw new Error(
      `Scratch command failed: ${String(result.stderr ?? '').slice(0, 200)}`,
    );
  return new TextDecoder('utf-8', { fatal: true }).decode(result.stdout);
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'stellar-private-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceHost = path.join(root, 'source');
  await mkdir(sourceHost);
  const source = linuxPath(sourceHost);
  const privateRoot =
    process.platform === 'win32'
      ? run(['mktemp', '-d', '/tmp/stellar-private-source-XXXXXX']).trim()
      : linuxPath(path.join(root, 'private'));
  if (process.platform === 'win32') {
    assert.match(privateRoot, /^\/tmp\/stellar-private-source-[A-Za-z0-9]+$/);
    t.after(() => {
      assert.equal(run(['realpath', '--', privateRoot]).trim(), privateRoot);
      run(['rm', '-rf', '--', privateRoot]);
    });
  } else await mkdir(privateRoot, { mode: 0o700 });
  const privateHost =
    process.platform === 'win32'
      ? `\\\\wsl.localhost\\Ubuntu${privateRoot.replaceAll('/', '\\')}`
      : privateRoot;
  const git = (...args) => run(['git', '-C', source, ...args]);
  git('init', '--quiet');
  git(
    '-c',
    'user.name=Tests',
    '-c',
    'user.email=tests@example.invalid',
    'commit',
    '--quiet',
    '--allow-empty',
    '-m',
    'fixture',
  );
  git('checkout', '--quiet', '-b', branch);
  await mkdir(path.join(sourceHost, 'src'));
  await writeFile(
    path.join(sourceHost, 'src', 'main.ts'),
    'export const value = 1;\n',
  );
  await writeFile(path.join(sourceHost, 'AGENTS.md'), 'trusted guidance\n');
  git('add', '.');
  git(
    '-c',
    'user.name=Tests',
    '-c',
    'user.email=tests@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'source',
  );
  const revision = git('rev-parse', 'HEAD').trim();
  const fingerprint = () =>
    inspectRestrictedWorkspace(issueNumber, branch, undefined, {
      workspace: source,
      runCommand: run,
    }).fingerprint;
  const prepare = (attemptId, extra = {}) =>
    preparePrivateSourceCopy({
      issueNumber,
      attemptId,
      workspace: source,
      privateRoot,
      expectedBranch: branch,
      expectedRevision: revision,
      expectedFingerprint: extra.expectedFingerprint ?? fingerprint(),
      authorizedChangePaths: ['src'],
      protectedPaths: ['AGENTS.md', 'tools/policy'],
      runCommand: run,
      ...extra,
    });
  return {
    root,
    sourceHost,
    privateHost,
    source,
    privateRoot,
    revision,
    fingerprint,
    prepare,
    git,
  };
}

test('captures clean tracked source without Git metadata or protected files', async (t) => {
  const f = await fixture(t);
  const before = await readFile(path.join(f.sourceHost, 'src', 'main.ts'));
  const result = f.prepare('clean-1');
  assert.equal(result.attemptId, 'clean-1');
  assert.equal(result.sourceRevision, f.revision);
  assert.equal(result.privatePath, `${f.privateRoot}/clean-1/workspace`);
  assert.equal(result.files.length, 1);
  assert.deepEqual(result.files[0], {
    path: 'src/main.ts',
    bytes: before.length,
    sha256: createHash('sha256').update(before).digest('hex'),
    mode: result.files[0].mode,
  });
  assert.match(result.files[0].mode, /^(600|700)$/);
  assert.equal(
    run(['stat', '-c', '%a', `${result.privatePath}/src/main.ts`]).trim(),
    result.files[0].mode,
  );
  assert.match(result.contentDigest, /^[a-f0-9]{64}$/);
  assert.equal(
    await readFile(
      path.join(f.privateHost, 'clean-1', 'workspace', 'src', 'main.ts'),
      'utf8',
    ),
    before.toString(),
  );
  assert.equal(existsSync(path.join(f.privateHost, 'clean-1', '.git')), false);
  assert.equal(
    existsSync(path.join(f.privateHost, 'clean-1', 'AGENTS.md')),
    false,
  );
  assert.equal(
    existsSync(
      path.join(f.privateHost, 'clean-1', 'workspace', 'manifest.json'),
    ),
    false,
  );
  assert.equal(
    existsSync(path.join(f.privateHost, 'clean-1', '.incomplete')),
    false,
  );
  const saved = JSON.parse(
    await readFile(path.join(f.privateHost, 'clean-1', 'manifest.json')),
  );
  assert.equal(saved.contentDigest, result.contentDigest);
  assert.equal(
    await readFile(path.join(f.sourceHost, 'src', 'main.ts'), 'utf8'),
    before.toString(),
  );
});

test('captures authorized modified and untracked files, and rejects out-of-scope edits', async (t) => {
  const f = await fixture(t);
  await writeFile(
    path.join(f.sourceHost, 'src', 'main.ts'),
    'export const value = 2;\n',
  );
  await writeFile(
    path.join(f.sourceHost, 'src', 'new.ts'),
    'export const next = 3;\n',
  );
  if (process.platform !== 'win32')
    await chmod(path.join(f.sourceHost, 'src', 'new.ts'), 0o700);
  const result = f.prepare('dirty-1');
  assert.deepEqual(
    result.files.map((item) => item.path),
    ['src/main.ts', 'src/new.ts'],
  );
  if (process.platform !== 'win32')
    assert.equal(
      result.files.find((file) => file.path === 'src/new.ts').mode,
      '700',
    );
  assert.equal(
    await readFile(
      path.join(f.privateHost, 'dirty-1', 'workspace', 'src', 'new.ts'),
      'utf8',
    ),
    'export const next = 3;\n',
  );
  await writeFile(path.join(f.sourceHost, 'README.md'), 'unauthorized\n');
  assert.throws(() => f.prepare('dirty-2'), /authorized scope/);
  assert.equal(existsSync(path.join(f.privateHost, 'dirty-2')), false);
  await rm(path.join(f.sourceHost, 'README.md'));
  await writeFile(
    path.join(f.sourceHost, 'AGENTS.md'),
    'changed protected guidance\n',
  );
  assert.throws(() => f.prepare('protected-1'), /authorized scope/);
  assert.equal(existsSync(path.join(f.privateHost, 'protected-1')), false);
});

test('detects source mutation or replacement before finalization and quarantines only that attempt', async (t) => {
  const f = await fixture(t);
  const original = await readFile(
    path.join(f.sourceHost, 'src', 'main.ts'),
    'utf8',
  );
  let changed = false;
  const mutate = (args, options) => {
    const result = run(args, options);
    if (!changed && args.includes('prepare')) {
      changed = true;
      writeFileSync(
        path.join(f.sourceHost, 'src', 'main.ts'),
        'changed during copy\n',
      );
    }
    return result;
  };
  assert.throws(
    () => f.prepare('mutated-1', { runCommand: mutate }),
    /Source changed/,
  );
  assert.equal(changed, true);
  assert.equal(
    existsSync(path.join(f.privateHost, 'mutated-1', '.incomplete')),
    true,
  );
  assert.equal(
    await readFile(path.join(f.sourceHost, 'src', 'main.ts'), 'utf8'),
    'changed during copy\n',
  );
  await writeFile(path.join(f.sourceHost, 'src', 'main.ts'), original);
  const replacement = path.join(f.sourceHost, 'src', 'replacement.ts');
  await writeFile(replacement, original);
  let replaced = false;
  const swap = (args, options) => {
    const result = run(args, options);
    if (!replaced && args.includes('prepare')) {
      replaced = true;
      renameSync(replacement, path.join(f.sourceHost, 'src', 'main.ts'));
    }
    return result;
  };
  assert.throws(
    () => f.prepare('replaced-1', { runCommand: swap }),
    /Source changed/,
  );
  assert.equal(
    existsSync(path.join(f.privateHost, 'replaced-1', '.incomplete')),
    true,
  );
});

test('rejects stale or duplicate attempt identity without source changes', async (t) => {
  const f = await fixture(t);
  const before = await readFile(
    path.join(f.sourceHost, 'src', 'main.ts'),
    'utf8',
  );
  assert.throws(
    () => f.prepare('stale-1', { expectedFingerprint: '0'.repeat(64) }),
    /stale/,
  );
  assert.equal(existsSync(path.join(f.privateHost, 'stale-1')), false);
  f.prepare('duplicate-1');
  assert.throws(() => f.prepare('duplicate-1'), /capture failed/);
  assert.equal(
    await readFile(path.join(f.sourceHost, 'src', 'main.ts'), 'utf8'),
    before,
  );
});

test('rejects active Git filters before status can execute them and requires private storage', async (t) => {
  const f = await fixture(t);
  const marker = path.join(f.root, 'filter-ran');
  await writeFile(
    path.join(f.sourceHost, 'src', '.gitattributes'),
    'main.ts filter=probe\n',
  );
  await writeFile(path.join(f.sourceHost, 'src', 'main.ts'), 'changed\n');
  const fingerprint = f.fingerprint();
  f.git(
    'config',
    'filter.probe.clean',
    `sh -c 'touch ${linuxPath(marker)}; cat'`,
  );
  assert.throws(
    () => f.prepare('filter-1', { expectedFingerprint: fingerprint }),
    /External Git filters/,
  );
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(path.join(f.privateHost, 'filter-1')), false);
  f.git('config', '--unset', 'filter.probe.clean');
  await writeFile(
    path.join(f.sourceHost, 'src', '.gitattributes'),
    'main.ts filter=\n',
  );
  const emptyFingerprint = f.fingerprint();
  f.git('config', 'filter..clean', `sh -c 'touch ${linuxPath(marker)}; cat'`);
  assert.throws(
    () =>
      f.prepare('empty-filter-1', { expectedFingerprint: emptyFingerprint }),
    /External Git filters/,
  );
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(path.join(f.privateHost, 'empty-filter-1')), false);
  f.git('config', '--unset', 'filter..clean');
  await rm(path.join(f.sourceHost, 'src', '.gitattributes'));
  await writeFile(
    path.join(f.sourceHost, 'src', 'main.ts'),
    'export const value = 1;\n',
  );
  run(['chmod', '777', f.privateRoot]);
  assert.throws(() => f.prepare('public-1'), /capture failed/);
  assert.equal(existsSync(path.join(f.privateHost, 'public-1')), false);
  run(['chmod', '700', f.privateRoot]);
});

test('rejects symlinks, special files, unexpected Git metadata, and oversized files', async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.root, 'outside.txt');
  await writeFile(outside, 'outside\n');
  try {
    await symlink(outside, path.join(f.sourceHost, 'src', 'link.ts'));
    assert.throws(() => f.prepare('link-1'));
    assert.equal(
      existsSync(path.join(f.privateHost, 'link-1', '.incomplete')),
      false,
    );
    await rm(path.join(f.sourceHost, 'src', 'link.ts'));
  } catch (error) {
    if (error?.code !== 'EPERM') throw error;
  }
  if (process.platform !== 'win32') {
    run(['mkfifo', path.join(f.sourceHost, 'src', 'pipe')]);
    assert.throws(() => f.prepare('fifo-1'));
    assert.equal(
      existsSync(path.join(f.privateHost, 'fifo-1', '.incomplete')),
      false,
    );
    await rm(path.join(f.sourceHost, 'src', 'pipe'));
  }
  await mkdir(path.join(f.sourceHost, 'src', '.git'));
  await writeFile(path.join(f.sourceHost, 'src', '.git', 'config'), 'unsafe\n');
  assert.throws(() => f.prepare('metadata-1'));
  assert.equal(
    existsSync(path.join(f.privateHost, 'metadata-1', '.incomplete')),
    false,
  );
  await rm(path.join(f.sourceHost, 'src', '.git'), { recursive: true });
  await writeFile(
    path.join(f.sourceHost, 'src', 'oversized.ts'),
    'x'.repeat(8 * 1024 * 1024 + 1),
  );
  assert.throws(() => f.prepare('oversized-1'));
  assert.equal(
    existsSync(path.join(f.privateHost, 'oversized-1', '.incomplete')),
    false,
  );
});

test('rejects traversal and interrupted capture without exposing a ready copy', async (t) => {
  const f = await fixture(t);
  const direct = spawnSync(
    process.platform === 'win32' ? 'wsl.exe' : 'python3',
    process.platform === 'win32'
      ? [
          '--distribution',
          'Ubuntu',
          '--exec',
          'python3',
          '-I',
          '-',
          'prepare',
          f.source,
          f.privateRoot,
          'traversal-1',
          f.revision,
          f.fingerprint(),
          JSON.stringify(['../outside.txt']),
          '[]',
        ]
      : [
          '-I',
          '-',
          'prepare',
          f.source,
          f.privateRoot,
          'traversal-1',
          f.revision,
          f.fingerprint(),
          JSON.stringify(['../outside.txt']),
          '[]',
        ],
    { input: helper, encoding: 'utf8', timeout: 15_000 },
  );
  assert.notEqual(direct.status, 0);
  assert.equal(existsSync(path.join(f.privateHost, 'traversal-1')), false);
  const controller = new AbortController();
  const interrupt = (args, options) => {
    const result = run(args, options);
    if (args.includes('prepare')) controller.abort();
    return result;
  };
  assert.throws(
    () =>
      f.prepare('interrupted-1', {
        runCommand: interrupt,
        signal: controller.signal,
      }),
    /cancelled/,
  );
  assert.equal(
    existsSync(path.join(f.privateHost, 'interrupted-1', '.incomplete')),
    true,
  );
});
