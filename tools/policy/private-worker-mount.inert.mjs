/** Disposable WSL/Podman mount probe. It never invokes Hermes or a model. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { preparePrivateSourceCopy } from './prepare-private-source.mjs';
import {
  buildPrivatePodmanArgs,
  inspectRestrictedWorkspace,
} from './run-restricted-worker.mjs';
import { trustedPeonWorkerImage } from './supervised-peon-run.mjs';
import { stopAndConfirmContainer } from './worker-container-lifecycle.mjs';

const issueNumber = 145;
const branch = 'issue/145-inert-private-mount';
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const wslRepository = repositoryRoot
  .replace(/^([A-Za-z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`)
  .replaceAll('\\', '/');

function peon(args, { timeout = 20_000, maxBuffer = 64 * 1024 } = {}) {
  const result = spawnSync(
    'wsl.exe',
    ['--distribution', 'Ubuntu', '--user', 'peon', '--exec', ...args],
    { cwd: repositoryRoot, windowsHide: true, timeout, maxBuffer },
  );
  if (result.error || result.status !== 0)
    throw new Error(
      `Inert WSL command failed: ${args[0]} (${result.status ?? 'no exit'}).`,
    );
  return new TextDecoder('utf-8', { fatal: true }).decode(result.stdout).trim();
}

function writeScratch(name, content) {
  peon([
    'python3',
    '-I',
    '-c',
    'import pathlib,sys; p=pathlib.Path(sys.argv[1]); p.parent.mkdir(parents=True,exist_ok=True); p.write_text(sys.argv[2],encoding="utf-8")',
    name,
    content,
  ]);
}

function podman(args, options) {
  return peon(['podman', ...args], { timeout: 30_000, ...options });
}

function inertArgs(mount, command, detached = false) {
  const imageIndex = mount.args.indexOf(trustedPeonWorkerImage);
  assert.ok(imageIndex > 0);
  return [
    ...mount.args.slice(0, imageIndex),
    ...(detached ? ['--detach'] : []),
    '--entrypoint=/bin/sh',
    trustedPeonWorkerImage,
    '-c',
    command,
  ];
}

function assertMounts(mounts, first, second, source, protectedRoot) {
  const find = (destination) =>
    mounts.find((mount) => mount.Destination === destination);
  const root = find('/workspace');
  const writable = find('/workspace/src');
  const protectedFile = find('/workspace/policy/guard.txt');
  const guidance = find('/workspace/AGENTS.md');
  assert.equal(root?.Source, first.privatePath);
  assert.equal(writable?.Source, `${first.privatePath}/src`);
  assert.equal(protectedFile?.Source, `${protectedRoot}/policy/guard.txt`);
  assert.equal(
    guidance?.Source,
    `${wslRepository}/tools/policy/peon-coding-agents.md`,
  );
  assert.equal(root.RW, false);
  assert.equal(writable.RW, true);
  assert.equal(protectedFile.RW, false);
  assert.equal(guidance.RW, false);
  assert.ok(
    mounts.every(
      (mount) =>
        mount.Source !== source &&
        !mount.Source.startsWith(`${source}/`) &&
        mount.Source !== second.privatePath &&
        !mount.Source.startsWith(`${second.privatePath}/`) &&
        !mount.Source.includes('/manifest.json'),
    ),
  );
}

async function main() {
  if (process.platform !== 'win32')
    throw new Error(
      'The inert Podman probe requires the existing Windows/WSL host.',
    );
  const scratch = peon([
    'mktemp',
    '-d',
    '/home/peon/stellar-inert-mount-XXXXXX',
  ]);
  assert.match(scratch, /^\/home\/peon\/stellar-inert-mount-[A-Za-z0-9]+$/);
  const source = `${scratch}/source`;
  const privateRoot = `${scratch}/private`;
  const trustedProtectedRoot = `${scratch}/protected`;
  let activeName;
  let safeToRemove = true;
  try {
    for (const directory of [source, privateRoot, trustedProtectedRoot])
      peon(['mkdir', '-m', '700', '--', directory]);
    writeScratch(`${source}/src/main.ts`, 'export const value = 1;\n');
    writeScratch(`${source}/policy/readme.txt`, 'ordinary\n');
    writeScratch(`${source}/policy/guard.txt`, 'source protected\n');
    writeScratch(`${source}/AGENTS.md`, 'source guidance\n');
    writeScratch(
      `${trustedProtectedRoot}/policy/guard.txt`,
      'trusted protected\n',
    );
    writeScratch(`${trustedProtectedRoot}/AGENTS.md`, 'trusted guidance\n');
    peon(['git', 'init', '--quiet', '-b', branch, source]);
    peon(['git', '-C', source, 'add', '.']);
    peon([
      'git',
      '-C',
      source,
      '-c',
      'user.name=Inert Probe',
      '-c',
      'user.email=inert@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'fixture',
    ]);
    const revision = peon(['git', '-C', source, 'rev-parse', 'HEAD']);
    const fingerprint = inspectRestrictedWorkspace(
      issueNumber,
      branch,
      undefined,
      {
        workspace: source,
      },
    ).fingerprint;
    const attemptNumber = 100000 + Math.floor(Math.random() * 800000);
    const makeCopy = (number) =>
      preparePrivateSourceCopy({
        issueNumber,
        attemptId: `issue-${issueNumber}-attempt-${number}`,
        workspace: source,
        privateRoot,
        expectedBranch: branch,
        expectedRevision: revision,
        expectedFingerprint: fingerprint,
        authorizedChangePaths: ['src'],
        protectedPaths: ['AGENTS.md', 'policy/guard.txt'],
      });
    const first = makeCopy(attemptNumber);
    const second = makeCopy(attemptNumber + 1);
    const options = (copy, number) => ({
      issueNumber,
      attemptNumber: number,
      privateCopy: copy,
      privateRoot,
      expectedRevision: revision,
      expectedFingerprint: fingerprint,
      expectedDigest: copy.contentDigest,
      trustedProtectedRoot,
      image: trustedPeonWorkerImage,
      uid: Number(peon(['id', '-u'])),
      gid: Number(peon(['id', '-g'])),
      command: ['hermes', 'chat'],
      protectedPaths: ['AGENTS.md', 'policy/guard.txt'],
      hermesProfile: 'narrow-coding',
      hermesConfigSource: `${wslRepository}/tools/policy/peon-hermes-narrow-config.yaml`,
      writablePaths: ['src'],
      minimalGuidanceSource: `${wslRepository}/tools/policy/peon-coding-agents.md`,
    });
    podman(['image', 'exists', trustedPeonWorkerImage]);
    const firstMount = buildPrivatePodmanArgs(options(first, attemptNumber));
    const secondMount = buildPrivatePodmanArgs(
      options(second, attemptNumber + 1),
    );
    activeName = `stellar-peon-worker-${issueNumber}-${attemptNumber}`;
    const existing = spawnSync(
      'wsl.exe',
      [
        '--distribution',
        'Ubuntu',
        '--user',
        'peon',
        '--exec',
        'podman',
        'container',
        'exists',
        activeName,
      ],
      { windowsHide: true, timeout: 5_000 },
    );
    if (existing.status === 0)
      throw new Error('Inert container name already exists.');
    if (existing.status !== 1)
      throw new Error('Could not check inert container name.');
    podman(inertArgs(firstMount, 'sleep 60', true));
    const mounts = JSON.parse(
      podman(['inspect', '--format', '{{json .Mounts}}', activeName]),
    );
    assertMounts(mounts, first, second, source, trustedProtectedRoot);
    podman([
      'exec',
      activeName,
      '/bin/sh',
      '-c',
      'set -eu; test "$(cat /workspace/src/main.ts)" = "export const value = 1;"; ' +
        'printf "private-output\\n" > /workspace/src/output.txt; ' +
        'test "$(cat /workspace/policy/guard.txt)" = "trusted protected"; ' +
        'if printf denied > /workspace/policy/guard.txt 2>/dev/null; then exit 71; fi; ' +
        'if printf denied > /workspace/AGENTS.md 2>/dev/null; then exit 72; fi; ' +
        'test ! -e /workspace/manifest.json; test ! -e /workspace/.git',
    ]);
    assert.equal(
      peon(['cat', `${first.privatePath}/src/output.txt`]),
      'private-output',
    );
    assert.equal(
      peon(['cat', `${source}/src/main.ts`]),
      'export const value = 1;',
    );
    assert.equal(peon(['git', '-C', source, 'status', '--porcelain']), '');
    assert.equal(
      peon(['cat', `${second.privatePath}/src/main.ts`]),
      'export const value = 1;',
    );
    assert.equal(
      peon(['test', '!', '-e', `${second.privatePath}/src/output.txt`]),
      '',
    );
    const stopped = await stopAndConfirmContainer(activeName);
    if (!stopped.confirmed) {
      safeToRemove = false;
      throw new Error('Inert container cancellation was not confirmed.');
    }
    activeName = undefined;
    const naturalName = `stellar-peon-worker-${issueNumber}-${attemptNumber + 1}`;
    podman(inertArgs(secondMount, 'test -f /workspace/src/main.ts'));
    const natural = await stopAndConfirmContainer(naturalName);
    assert.equal(natural.confirmed, true);
    assert.equal(natural.state, 'absent');
    podman(
      inertArgs(
        secondMount,
        'command -v git >/dev/null; command -v node >/dev/null; command -v pnpm >/dev/null',
      ),
    );
    const gitProbe = spawnSync(
      'wsl.exe',
      [
        '--distribution',
        'Ubuntu',
        '--user',
        'peon',
        '--exec',
        'podman',
        ...inertArgs(
          secondMount,
          'git -C /workspace rev-parse --is-inside-work-tree >/dev/null 2>&1',
        ),
      ],
      { cwd: repositoryRoot, windowsHide: true, timeout: 30_000 },
    );
    assert.notEqual(gitProbe.status, 0);
    assert.equal(
      peon(['test', '!', '-e', `${second.privatePath}/node_modules`]),
      '',
    );
    process.stdout.write(
      JSON.stringify(
        {
          image: trustedPeonWorkerImage,
          attempt: first.attemptId,
          privateWorkspace: first.privatePath,
          sourceRead: true,
          privateWrite: true,
          protectedWritesDenied: true,
          authoritativeUnchanged: true,
          otherAttemptUnchanged: true,
          mountInspection: true,
          cancellationConfirmed: stopped,
          naturalTerminationConfirmed: natural,
          gitMetadataAbsent: true,
          ignoredDependenciesAbsent: true,
        },
        null,
        2,
      ) + '\n',
    );
  } finally {
    if (activeName) {
      const stopped = await stopAndConfirmContainer(activeName);
      if (!stopped.confirmed) safeToRemove = false;
    }
    if (safeToRemove) {
      assert.equal(peon(['realpath', '--', scratch]), scratch);
      peon(['rm', '-rf', '--', scratch]);
    } else {
      process.stderr.write(
        `Uncertain inert container state; retained scratch ${scratch}\n`,
      );
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
