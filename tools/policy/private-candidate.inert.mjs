/** Disposable pinned-image candidate probe; no Hermes or model invocation. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { preparePrivateSourceCopy } from './prepare-private-source.mjs';
import {
  buildPrivatePodmanArgs,
  inspectRestrictedWorkspace,
} from './run-restricted-worker.mjs';
import {
  collectPrivateCandidate,
  verifyPrivateCandidate,
} from './private-candidate.mjs';
import { trustedPeonWorkerImage } from './supervised-peon-run.mjs';
import { stopAndConfirmContainer } from './worker-container-lifecycle.mjs';

const issueNumber = 147;
const branch = 'issue/147-inert-candidate';
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const wslRepository = repositoryRoot
  .replace(/^([A-Za-z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`)
  .replaceAll('\\', '/');

function peon(args, { timeout = 20_000, expected = 0 } = {}) {
  const result = spawnSync(
    'wsl.exe',
    ['--distribution', 'Ubuntu', '--user', 'peon', '--exec', ...args],
    { cwd: repositoryRoot, windowsHide: true, timeout, maxBuffer: 64 * 1024 },
  );
  if (result.error || result.status !== expected)
    throw new Error(
      `Inert command failed: ${args[0]} (${result.status ?? 'no exit'}).`,
    );
  return result.stdout.toString('utf8').trim();
}

function write(name, content) {
  peon([
    'python3',
    '-I',
    '-c',
    'import pathlib,sys; p=pathlib.Path(sys.argv[1]); p.parent.mkdir(parents=True,exist_ok=True); p.write_text(sys.argv[2],encoding="utf-8")',
    name,
    content,
  ]);
}

async function main() {
  if (process.platform !== 'win32')
    throw new Error(
      'The inert Podman probe requires the configured Windows/WSL host.',
    );
  const scratch = peon([
    'mktemp',
    '-d',
    '/home/peon/stellar-candidate-inert-XXXXXX',
  ]);
  assert.match(scratch, /^\/home\/peon\/stellar-candidate-inert-[A-Za-z0-9]+$/);
  const source = `${scratch}/source`;
  const privateRoot = `${scratch}/private`;
  const candidateRoot = `${scratch}/candidate`;
  const trustedProtectedRoot = `${scratch}/protected`;
  const active = new Set();
  let safeToRemove = true;
  try {
    for (const directory of [
      source,
      privateRoot,
      candidateRoot,
      trustedProtectedRoot,
    ])
      peon(['mkdir', '-m', '700', '--', directory]);
    write(`${source}/src/change.txt`, 'before\n');
    write(`${source}/src/delete.txt`, 'delete\n');
    write(`${source}/docs/stable.txt`, 'stable\n');
    write(`${source}/AGENTS.md`, 'source protected\n');
    write(`${trustedProtectedRoot}/AGENTS.md`, 'trusted protected\n');
    peon(['git', 'init', '--quiet', '-b', branch, source]);
    peon(['git', '-C', source, 'add', '.']);
    peon([
      'git',
      '-C',
      source,
      '-c',
      'user.name=Inert',
      '-c',
      'user.email=inert@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'fixture',
    ]);
    const expectedRevision = peon(['git', '-C', source, 'rev-parse', 'HEAD']);
    const expectedFingerprint = inspectRestrictedWorkspace(
      issueNumber,
      branch,
      undefined,
      { workspace: source },
    ).fingerprint;
    const attemptNumber = 100000 + Math.floor(Math.random() * 800000);
    const makeCopy = (number) =>
      preparePrivateSourceCopy({
        issueNumber,
        attemptId: `issue-${issueNumber}-attempt-${number}`,
        workspace: source,
        privateRoot,
        expectedBranch: branch,
        expectedRevision,
        expectedFingerprint,
        authorizedChangePaths: ['src'],
        protectedPaths: ['AGENTS.md'],
      });
    const privateCopy = makeCopy(attemptNumber);
    const otherCopy = makeCopy(attemptNumber + 1);
    const uid = Number(peon(['id', '-u']));
    const gid = Number(peon(['id', '-g']));
    const mount = buildPrivatePodmanArgs({
      issueNumber,
      attemptNumber,
      privateCopy,
      privateRoot,
      expectedRevision,
      expectedFingerprint,
      expectedDigest: privateCopy.contentDigest,
      trustedProtectedRoot,
      image: trustedPeonWorkerImage,
      uid,
      gid,
      command: ['/bin/sh', '-c', 'true'],
      protectedPaths: ['AGENTS.md'],
      hermesProfile: 'narrow-coding',
      hermesConfigSource: `${wslRepository}/tools/policy/peon-hermes-narrow-config.yaml`,
      writablePaths: ['src'],
      minimalGuidanceSource: `${wslRepository}/tools/policy/peon-coding-agents.md`,
    });
    peon(['podman', 'image', 'exists', trustedPeonWorkerImage]);
    const workerName = `stellar-peon-worker-${issueNumber}-${attemptNumber}`;
    const index = mount.args.indexOf(trustedPeonWorkerImage);
    assert.ok(index > 0);
    active.add(workerName);
    peon(
      [
        'podman',
        ...mount.args.slice(0, index),
        '--entrypoint=/bin/sh',
        trustedPeonWorkerImage,
        '-c',
        'set -eu; printf "after\\n" > /workspace/src/change.txt; ' +
          'printf "added\\n" > /workspace/src/add.txt; ' +
          'rm /workspace/src/delete.txt; test -f /workspace/docs/stable.txt',
      ],
      { timeout: 30_000 },
    );
    const stopped = await stopAndConfirmContainer(workerName);
    if (!stopped.confirmed)
      throw new Error('Inert worker termination uncertain.');
    active.delete(workerName);
    const options = {
      issueNumber,
      attemptNumber,
      privateCopy,
      privateRoot,
      candidateRoot,
      trustedProtectedRoot,
      expectedRevision,
      expectedFingerprint,
      expectedBaselineDigest: privateCopy.contentDigest,
      authorizedChangePaths: ['src'],
      protectedPaths: ['AGENTS.md'],
      uid,
      gid,
      workerCompletion: Promise.resolve(),
    };
    const candidate = await collectPrivateCandidate(options);
    assert.deepEqual(candidate.changes, [
      { path: 'src/add.txt', status: 'added' },
      { path: 'src/change.txt', status: 'modified' },
      { path: 'src/delete.txt', status: 'deleted' },
    ]);
    assert.equal(
      peon(['cat', `${candidate.privatePath}/docs/stable.txt`]),
      'stable',
    );
    assert.equal(peon(['cat', `${source}/src/change.txt`]), 'before');
    assert.equal(
      peon(['cat', `${otherCopy.privatePath}/src/change.txt`]),
      'before',
    );
    const verifyName = `stellar-peon-verify-${issueNumber}-${attemptNumber}`;
    active.add(verifyName);
    const evidence = await verifyPrivateCandidate(options, candidate);
    active.delete(verifyName);
    assert.equal(evidence.candidateDigest, candidate.contentDigest);
    assert.equal(
      peon(['cat', `${candidate.privatePath}/src/change.txt`]),
      'after',
    );
    peon(['test', '!', '-e', `${candidate.privatePath}/AGENTS.md`]);
    peon([
      'test',
      '-f',
      `${candidateRoot}/${candidate.attemptId}/.quarantined`,
    ]);
    assert.equal(
      peon([
        'test',
        '-f',
        `${candidateRoot}/${candidate.attemptId}/verification.json`,
      ]),
      '',
    );
    process.stdout.write(
      `${JSON.stringify(
        {
          image: trustedPeonWorkerImage,
          attemptId: candidate.attemptId,
          candidateDigest: candidate.contentDigest,
          changes: candidate.changes,
          workerTermination: stopped,
          verification: evidence,
          sourceUnchanged: true,
          otherAttemptUnchanged: true,
          quarantinedCandidate: true,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    for (const name of active) {
      const stopped = await stopAndConfirmContainer(name);
      if (!stopped.confirmed) safeToRemove = false;
    }
    if (safeToRemove) {
      assert.equal(peon(['realpath', '--', scratch]), scratch);
      peon(['rm', '-rf', '--', scratch]);
    } else {
      process.stderr.write(`Uncertain container state; retained ${scratch}\n`);
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
