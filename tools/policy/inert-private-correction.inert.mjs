/** Disposable full private-correction probe. No Hermes or model request. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInertPrivateCorrection } from './inert-private-correction.mjs';
import { preparePrivateSourceCopy } from './prepare-private-source.mjs';
import { inspectRestrictedWorkspace } from './run-restricted-worker.mjs';
import { readHandoff } from './supervise-worker.mjs';
import { stopAndConfirmContainer } from './worker-container-lifecycle.mjs';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const wslRepository = repositoryRoot
  .replace(/^([A-Za-z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`)
  .replaceAll('\\', '/');
const sha = (value) => createHash('sha256').update(value).digest('hex');
const issueNumber = 151;
const branch = 'issue/151-inert-orchestration-fixture';
const cacheRoot =
  '/home/peon/stellar-dependency-cache/9f7d2f801be4f1c6bc6b9bea5c6a7a3ffe64e0b7ee69fab9a4a1b3a8cf4b5fc0';

function peon(
  args,
  { timeout = 30_000, maxBuffer = 2 * 1024 * 1024, input } = {},
) {
  const result = spawnSync(
    'wsl.exe',
    ['--distribution', 'Ubuntu', '--user', 'peon', '--exec', ...args],
    { cwd: repositoryRoot, timeout, maxBuffer, input, windowsHide: true },
  );
  if (result.error || result.status !== 0)
    throw new Error(
      `Inert ${args[0]} failed (${result.status}): ${result.stderr?.toString('utf8').slice(0, 500)}`,
    );
  return result.stdout.toString('utf8').trim();
}

function runCommand(args, options) {
  return peon(args, options);
}

async function main() {
  if (process.platform !== 'win32')
    throw new Error('Requires configured Windows/WSL host.');
  const mode = process.argv.includes('--cancel')
    ? 'cancel'
    : process.argv.includes('--unchanged')
      ? 'unchanged'
      : process.argv.includes('--worker-failure')
        ? 'worker-failure'
        : process.argv.includes('--failed-test')
          ? 'failed-test'
          : 'success';
  const scratch = peon([
    'mktemp',
    '-d',
    '/home/peon/stellar-inert-orchestration-XXXXXX',
  ]);
  assert.match(
    scratch,
    /^\/home\/peon\/stellar-inert-orchestration-[A-Za-z0-9]+$/,
  );
  const local = await mkdtemp(path.join(os.tmpdir(), 'stellar-151-inert-'));
  const localRepo = path.join(local, 'repo');
  await mkdir(localRepo);
  const handoffPath = path.join(local, 'handoff.json');
  const sourceWorkspace = `${scratch}/source`;
  const privateRoot = `${scratch}/private`;
  const candidateRoot = `${scratch}/candidate`;
  const testRoot = `${scratch}/tests`;
  const trustedProtectedRoot = `${scratch}/protected`;
  let safeToRemove = false;
  let attemptId;
  try {
    for (const dir of [
      sourceWorkspace,
      privateRoot,
      candidateRoot,
      testRoot,
      trustedProtectedRoot,
    ])
      peon(['mkdir', '-m', '700', '--', dir]);
    const archive = spawnSync('git', ['archive', '--format=tar', 'HEAD'], {
      cwd: repositoryRoot,
      env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    });
    if (archive.error || archive.status !== 0)
      throw new Error('Source archive failed.');
    const extract = spawnSync(
      'wsl.exe',
      [
        '--distribution',
        'Ubuntu',
        '--user',
        'peon',
        '--exec',
        'tar',
        '-xf',
        '-',
        '-C',
        sourceWorkspace,
      ],
      {
        input: archive.stdout,
        timeout: 30_000,
        maxBuffer: 1024,
        windowsHide: true,
      },
    );
    if (extract.error || extract.status !== 0)
      throw new Error('Source extraction failed.');
    // The committed blobs supply exact LF lockfile inputs on Windows.
    // The worktree package.json includes this milestone's policy:test entry.
    for (const name of [
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
    ]) {
      let bytes;
      if (name === 'package.json')
        bytes = await readFile(path.join(repositoryRoot, name));
      else {
        const blob = spawnSync('git', ['cat-file', 'blob', `HEAD:${name}`], {
          cwd: repositoryRoot,
          env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
          maxBuffer: 2 * 1024 * 1024,
          windowsHide: true,
        });
        if (blob.error || blob.status !== 0)
          throw new Error('Trusted Git blob read failed.');
        bytes = blob.stdout;
      }
      peon(
        [
          'python3',
          '-I',
          '-c',
          'import pathlib,sys; pathlib.Path(sys.argv[1]).write_bytes(sys.stdin.buffer.read())',
          `${sourceWorkspace}/${name}`,
        ],
        { input: bytes },
      );
    }
    peon([
      'cp',
      `${sourceWorkspace}/AGENTS.md`,
      `${trustedProtectedRoot}/AGENTS.md`,
    ]);
    peon(['git', 'init', '--quiet', '-b', branch, sourceWorkspace]);
    peon(['git', '-C', sourceWorkspace, 'add', '.']);
    peon([
      'git',
      '-C',
      sourceWorkspace,
      '-c',
      'user.name=Inert Probe',
      '-c',
      'user.email=inert@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'fixture',
    ]);
    const current = inspectRestrictedWorkspace(issueNumber, branch, undefined, {
      workspace: sourceWorkspace,
      runCommand,
    });
    let otherAttempt;
    let otherDigest;
    if (mode === 'success') {
      otherAttempt = preparePrivateSourceCopy({
        issueNumber,
        attemptId: `issue-${issueNumber}-attempt-900001`,
        workspace: sourceWorkspace,
        privateRoot,
        expectedBranch: branch,
        expectedRevision: current.headRevision,
        expectedFingerprint: current.fingerprint,
        authorizedChangePaths: ['libs'],
        protectedPaths: ['AGENTS.md'],
        runCommand,
        inspectWorkspace: (number, expected, base, config) =>
          inspectRestrictedWorkspace(number, expected, base, {
            ...config,
            runCommand,
          }),
      });
      otherDigest = peon([
        'sha256sum',
        `${otherAttempt.privatePath}/package.json`,
      ]);
    }
    const failure = {
      code: 'TestFailure',
      message: 'Disposable inert prior failure.',
    };
    const sealed = sha(current.fingerprint);
    const task = {
      issueNumber,
      owner: 'owner:codex',
      targetBranch: 'develop',
      branch,
      worktreePath: localRepo,
    };
    const handoff = {
      schemaVersion: 1,
      task,
      status: 'paused',
      safeToResume: true,
      executionOwner: 'inert-fixture',
      supervisorRevision: 0,
      updatedAt: new Date().toISOString(),
      attempts: [
        {
          workerId: 'peon',
          attemptNumber: 1,
          afterFingerprint: sealed,
          failure,
        },
      ],
      mentorFeedback: [
        {
          issueNumber,
          attemptNumber: 1,
          level: 'diagnostic',
          fingerprint: sealed,
          resultFingerprint: sealed,
          supervisorRevision: 0,
          executionOwner: 'inert-fixture',
          taskOwner: task.owner,
          attemptCount: 1,
          evidence: {
            kind: 'failure',
            fingerprint: sha(JSON.stringify(failure)),
          },
          diagnostic: 'Disposable inert prior failure.',
        },
      ],
    };
    await writeFile(handoffPath, `${JSON.stringify(handoff)}\n`);
    attemptId = `issue-${issueNumber}-attempt-2`;
    const options = {
      repositoryRoot: localRepo,
      issueNumber,
      sessionId: 'inert-fixture-session',
      handoffPath,
      sourceWorkspace,
      privateRoot,
      candidateRoot,
      testRoot,
      trustedProtectedRoot,
      authorizedChangePaths: ['libs'],
      protectedPaths: ['AGENTS.md'],
      writablePaths: ['libs'],
      editPath:
        mode === 'failed-test'
          ? 'libs/ui/atoms/src/lib/atoms/button-atom.component.spec.ts'
          : 'libs/inert-probe.txt',
      hermesConfigSource: `${wslRepository}/tools/policy/peon-hermes-narrow-config.yaml`,
      minimalGuidanceSource: `${wslRepository}/tools/policy/peon-coding-agents.md`,
      cacheRoot,
      checkNames:
        mode === 'success'
          ? [
              'nx-project-discovery',
              'ui-atoms-lint',
              'ui-atoms-test',
              'ui-atoms-build',
            ]
          : mode === 'failed-test'
            ? ['ui-atoms-test']
            : ['nx-project-discovery'],
      mode: mode === 'cancel' ? 'sleep' : mode,
    };
    const authority = {
      issue: {
        number: issueNumber,
        state: 'OPEN',
        labels: ['status:in-progress', 'owner:codex', 'target:develop'],
      },
      claim: {
        state: 'active',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        worker: 'owner:codex',
        sessionId: options.sessionId,
        branch,
        target: 'develop',
        worktreePath: localRepo,
      },
    };
    const controller = new AbortController();
    options.signal = controller.signal;
    const result = await runInertPrivateCorrection(options, {
      runCommand,
      inspectAuthority: async () => authority,
      onWorkerStart:
        mode === 'cancel'
          ? () => setTimeout(() => controller.abort(), 2500)
          : undefined,
      inspectWorkspace: () =>
        inspectRestrictedWorkspace(issueNumber, branch, undefined, {
          workspace: sourceWorkspace,
          runCommand,
        }),
    });
    assert.equal(
      result.status,
      mode === 'cancel'
        ? 'cancelled'
        : mode === 'unchanged'
          ? 'unchanged'
          : mode === 'worker-failure'
            ? 'worker-failed'
            : mode === 'failed-test'
              ? 'tests-failed'
              : 'tests-passed',
    );
    assert.equal((await readHandoff(handoffPath)).attempts.length, 1);
    assert.equal(
      peon(['git', '-C', sourceWorkspace, 'status', '--porcelain']),
      '',
    );
    peon(['test', '!', '-e', `${sourceWorkspace}/libs/inert-probe.txt`]);
    if (otherAttempt) {
      assert.equal(
        peon(['sha256sum', `${otherAttempt.privatePath}/package.json`]),
        otherDigest,
      );
      peon([
        'test',
        '!',
        '-e',
        `${otherAttempt.privatePath}/libs/inert-probe.txt`,
      ]);
    }
    if (mode === 'success') {
      assert.equal(
        peon([
          'cat',
          `${candidateRoot}/${attemptId}/workspace/libs/inert-probe.txt`,
        ]),
        'inert simulation',
      );
    }
    const journal = JSON.parse(
      await readFile(
        path.join(
          local,
          '.stellar-supervisor-state',
          'inert-correction',
          `${attemptId}.json`,
        ),
        'utf8',
      ),
    );
    assert.equal(journal.status, result.status);
    safeToRemove = true;
    process.stdout.write(
      `${JSON.stringify({ mode, result, journalStatus: journal.status, scratch })}\n`,
    );
  } finally {
    if (attemptId) {
      for (const name of [
        `stellar-peon-worker-${issueNumber}-2`,
        `stellar-peon-verify-${issueNumber}-2`,
      ]) {
        const stopped = await stopAndConfirmContainer(name);
        if (!stopped.confirmed) safeToRemove = false;
      }
    }
    if (safeToRemove && peon(['realpath', '--', scratch]) === scratch) {
      peon(['rm', '-rf', '--', scratch], { timeout: 60_000, maxBuffer: 1024 });
      await rm(local, { recursive: true, force: true });
    } else
      process.stderr.write(
        `Preserved uncertain inert scratch: ${scratch}; ${local}\n`,
      );
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
