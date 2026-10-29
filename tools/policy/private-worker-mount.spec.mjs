import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { preparePrivateSourceCopy } from './prepare-private-source.mjs';
import {
  buildPodmanArgs,
  buildPrivatePodmanArgs,
  inspectRestrictedWorkspace,
} from './run-restricted-worker.mjs';
import { trustedPeonWorkerImage } from './supervised-peon-run.mjs';

const issueNumber = 145;
const branch = 'issue/145-inert-mount';

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
    throw new Error('Disposable mount command failed.');
  return new TextDecoder('utf-8', { fatal: true }).decode(result.stdout);
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'stellar-private-mount-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceHost = path.join(root, 'source');
  await mkdir(sourceHost);
  const source = linuxPath(sourceHost);
  const git = (...args) => run(['git', '-C', source, ...args]);
  const privateRoot =
    process.platform === 'win32'
      ? run(['mktemp', '-d', '/tmp/stellar-private-mount-XXXXXX']).trim()
      : path.join(root, 'private');
  const trustedProtectedRoot =
    process.platform === 'win32'
      ? run(['mktemp', '-d', '/tmp/stellar-protected-mount-XXXXXX']).trim()
      : path.join(root, 'protected');
  if (process.platform === 'win32') {
    for (const directory of [privateRoot, trustedProtectedRoot]) {
      assert.match(
        directory,
        /^\/tmp\/stellar-(?:private|protected)-mount-[A-Za-z0-9]+$/,
      );
      t.after(() => {
        assert.equal(run(['realpath', '--', directory]).trim(), directory);
        run(['rm', '-rf', '--', directory]);
      });
    }
  } else {
    await mkdir(privateRoot, { mode: 0o700 });
    await mkdir(trustedProtectedRoot, { mode: 0o700 });
  }
  const protectedHost =
    process.platform === 'win32'
      ? `\\\\wsl.localhost\\Ubuntu${trustedProtectedRoot.replaceAll('/', '\\')}`
      : trustedProtectedRoot;
  const privateHost =
    process.platform === 'win32'
      ? `\\\\wsl.localhost\\Ubuntu${privateRoot.replaceAll('/', '\\')}`
      : privateRoot;
  await mkdir(path.join(protectedHost, 'policy'));
  await writeFile(path.join(protectedHost, 'AGENTS.md'), 'trusted guidance\n');
  await writeFile(
    path.join(protectedHost, 'policy', 'guard.txt'),
    'protected\n',
  );
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
  await mkdir(path.join(sourceHost, 'policy'));
  await writeFile(
    path.join(sourceHost, 'src', 'main.ts'),
    'export const value = 1;\n',
  );
  await writeFile(path.join(sourceHost, 'policy', 'readme.txt'), 'ordinary\n');
  await writeFile(
    path.join(sourceHost, 'policy', 'guard.txt'),
    'untrusted protected\n',
  );
  await writeFile(path.join(sourceHost, 'AGENTS.md'), 'untrusted guidance\n');
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
  const fingerprint = inspectRestrictedWorkspace(
    issueNumber,
    branch,
    undefined,
    {
      workspace: source,
      runCommand: run,
    },
  ).fingerprint;
  const prepare = (attemptNumber) =>
    preparePrivateSourceCopy({
      issueNumber,
      attemptId: `issue-${issueNumber}-attempt-${attemptNumber}`,
      workspace: source,
      privateRoot,
      expectedBranch: branch,
      expectedRevision: revision,
      expectedFingerprint: fingerprint,
      authorizedChangePaths: ['src'],
      protectedPaths: ['AGENTS.md', 'policy/guard.txt'],
      runCommand: run,
    });
  const worker = (privateCopy, attemptNumber, extra = {}) =>
    buildPrivatePodmanArgs(
      {
        issueNumber,
        attemptNumber,
        privateCopy,
        privateRoot,
        expectedRevision: revision,
        expectedFingerprint: fingerprint,
        expectedDigest: privateCopy.contentDigest,
        trustedProtectedRoot,
        image: trustedPeonWorkerImage,
        uid: 1001,
        gid: 1001,
        command: ['hermes', 'chat'],
        protectedPaths: ['AGENTS.md', 'policy/guard.txt'],
        hermesProfile: 'narrow-coding',
        hermesConfigSource:
          '/mnt/d/repo/tools/policy/peon-hermes-narrow-config.yaml',
        writablePaths: ['src'],
        minimalGuidanceSource: '/mnt/d/repo/tools/policy/peon-coding-agents.md',
        ...extra,
      },
      { runCommand: run },
    );
  return {
    source,
    sourceHost,
    privateRoot,
    privateHost,
    trustedProtectedRoot,
    revision,
    fingerprint,
    prepare,
    worker,
  };
}

test('uses only the exact finalized private source as the worker workspace', async (t) => {
  const f = await fixture(t);
  const copy = f.prepare(1);
  const mount = f.worker(copy, 1);
  assert.equal(mount.attemptId, 'issue-145-attempt-1');
  assert.equal(
    mount.workspace,
    `${f.privateRoot}/issue-145-attempt-1/workspace`,
  );
  assert.ok(
    mount.args.includes(
      `--mount=type=bind,src=${mount.workspace},dst=/workspace,ro`,
    ),
  );
  assert.ok(
    mount.args.includes(
      `--mount=type=bind,src=${mount.workspace}/src,dst=/workspace/src,rw`,
    ),
  );
  assert.ok(
    mount.args.includes(
      `--mount=type=bind,src=${f.trustedProtectedRoot}/policy/guard.txt,dst=/workspace/policy/guard.txt,ro`,
    ),
  );
  assert.ok(!mount.args.some((arg) => arg.includes(`src=${f.source},`)));
  assert.ok(!mount.args.some((arg) => arg.includes('/manifest.json')));
  assert.ok(!mount.args.some((arg) => arg.includes('target=GH_TOKEN')));
  assert.ok(
    mount.args.includes('--env=OPENAI_BASE_URL=http://peon-meter:18436/v1'),
  );
  assert.ok(mount.args.includes('--env=HTTPS_PROXY=http://peon-meter:3128'));
  for (const flag of [
    '--pull=never',
    '--userns=keep-id',
    '--read-only',
    '--cap-drop=all',
    '--security-opt=no-new-privileges',
    '--pids-limit=128',
    '--memory=4g',
    '--memory-swap=4g',
    '--cpus=2',
    '--network=stellar-peon-worker',
  ])
    assert.ok(mount.args.includes(flag));
  const ordinary = buildPodmanArgs({
    issueNumber,
    attemptNumber: 1,
    image: trustedPeonWorkerImage,
    uid: 1001,
    gid: 1001,
    command: ['hermes', 'chat'],
    protectedPaths: ['AGENTS.md', 'policy/guard.txt'],
    hermesProfile: 'narrow-coding',
    hermesConfigSource:
      '/mnt/d/repo/tools/policy/peon-hermes-narrow-config.yaml',
    writablePaths: ['src'],
    minimalGuidanceSource: '/mnt/d/repo/tools/policy/peon-coding-agents.md',
  });
  assert.ok(
    ordinary.includes(
      '--mount=type=bind,src=/home/peon/workspaces/issue-145,dst=/workspace,ro',
    ),
  );
  assert.equal(
    await readFile(path.join(f.sourceHost, 'src', 'main.ts'), 'utf8'),
    'export const value = 1;\n',
  );
  assert.equal(
    existsSync(
      path.join(f.privateHost, 'issue-145-attempt-1', 'workspace', 'AGENTS.md'),
    ),
    false,
  );
});

test('rejects wrong attempt, stale identity and authoritative mount roots', async (t) => {
  const f = await fixture(t);
  const first = f.prepare(1);
  const second = f.prepare(2);
  assert.throws(() => f.worker(second, 1), /Finalized private attempt/);
  assert.throws(
    () => f.worker(first, 1, { expectedDigest: '0'.repeat(64) }),
    /Finalized private attempt/,
  );
  assert.throws(
    () => f.worker(first, 1, { expectedRevision: '0'.repeat(40) }),
    /Finalized private attempt/,
  );
  assert.throws(
    () => f.worker({ ...first, privatePath: f.source }, 1),
    /Finalized private attempt/,
  );
  assert.throws(
    () => f.worker(first, 1, { privateRoot: '/home/peon/workspaces' }),
    /Finalized private attempt/,
  );
  assert.throws(
    () => f.worker(first, 1, { trustedProtectedRoot: f.privateRoot }),
    /Finalized private attempt/,
  );
  assert.throws(
    () => f.worker(first, 1, { writablePaths: undefined }),
    /Finalized private attempt/,
  );
});

test('rejects incomplete, changed and substituted private copies', async (t) => {
  const f = await fixture(t);
  const copy = f.prepare(1);
  const attemptHost = path.join(f.privateHost, 'issue-145-attempt-1');
  assert.throws(
    () =>
      f.worker(
        {
          ...copy,
          files: [{ ...copy.files[0], bytes: 1 }, ...copy.files.slice(1)],
        },
        1,
      ),
    /manifest no longer matches/,
  );
  await writeFile(path.join(attemptHost, '.incomplete'), 'uncertain\n');
  assert.throws(() => f.worker(copy, 1), /missing, incomplete, or changed/);
  await rm(path.join(attemptHost, '.incomplete'));
  await writeFile(
    path.join(attemptHost, 'workspace', 'src', 'main.ts'),
    'tampered\n',
  );
  assert.throws(() => f.worker(copy, 1), /missing, incomplete, or changed/);
  await writeFile(
    path.join(attemptHost, 'workspace', 'src', 'main.ts'),
    'export const value = 1;\n',
  );
  const manifestPath = path.join(attemptHost, 'manifest.json');
  const manifest = await readFile(manifestPath, 'utf8');
  await writeFile(
    manifestPath,
    manifest.replace(
      '"attemptId":"issue-145-attempt-1"',
      '"attemptId":"other-attempt"',
    ),
  );
  assert.throws(() => f.worker(copy, 1), /missing, incomplete, or changed/);
  const other = f.prepare(2);
  assert.notEqual(copy.contentDigest, other.contentDigest);
});
