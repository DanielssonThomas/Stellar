/** Full repository candidate probe. Inert: no Hermes or model inference. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { preparePrivateSourceCopy } from './prepare-private-source.mjs';
import { collectPrivateCandidate } from './private-candidate.mjs';
import { runPrivateCandidateChecks } from './private-candidate-tests.mjs';
import { inspectRestrictedWorkspace } from './run-restricted-worker.mjs';
import { stopAndConfirmContainer } from './worker-container-lifecycle.mjs';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const issueNumber = 149;
const branch = 'issue/149-inert-candidate';

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
      `Inert ${args[0]} failed (${result.status}): ${result.stderr?.toString('utf8').slice(0, 300)}`,
    );
  return result.stdout.toString('utf8').trim();
}

function runCommand(args, options = {}) {
  return peon(args, options);
}

async function main() {
  if (process.platform !== 'win32')
    throw new Error('Requires the configured Windows/WSL host.');
  const expectFailure = process.argv.includes('--expect-test-failure');
  const lfSource = process.argv.includes('--lf-source');
  const scratch = peon([
    'mktemp',
    '-d',
    '/home/peon/stellar-candidate-tests-inert-XXXXXX',
  ]);
  assert.match(
    scratch,
    /^\/home\/peon\/stellar-candidate-tests-inert-[A-Za-z0-9]+$/,
  );
  const source = `${scratch}/source`;
  const privateRoot = `${scratch}/private`;
  const candidateRoot = `${scratch}/candidate`;
  const trustedProtectedRoot = `${scratch}/protected`;
  const testRoot = `${scratch}/tests`;
  let safeToRemove = true;
  try {
    for (const directory of [
      source,
      privateRoot,
      candidateRoot,
      trustedProtectedRoot,
      testRoot,
    ])
      peon(['mkdir', '-m', '700', '--', directory]);
    const archive = spawnSync('git', ['archive', '--format=tar', 'HEAD'], {
      cwd: repositoryRoot,
      env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    });
    if (archive.error || archive.status !== 0)
      throw new Error('Trusted source archive failed.');
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
        source,
      ],
      {
        input: archive.stdout,
        timeout: 30_000,
        maxBuffer: 1024,
        windowsHide: true,
      },
    );
    if (extract.error || extract.status !== 0)
      throw new Error('Inert source extraction failed.');
    if (lfSource) {
      for (const name of [
        'package.json',
        'pnpm-lock.yaml',
        'pnpm-workspace.yaml',
      ]) {
        const blob = spawnSync('git', ['cat-file', 'blob', `HEAD:${name}`], {
          cwd: repositoryRoot,
          env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
          maxBuffer: 2 * 1024 * 1024,
          windowsHide: true,
        });
        if (blob.error || blob.status !== 0)
          throw new Error('Trusted Git blob read failed.');
        peon(
          [
            'python3',
            '-I',
            '-c',
            'import pathlib,sys; pathlib.Path(sys.argv[1]).write_bytes(sys.stdin.buffer.read())',
            `${source}/${name}`,
          ],
          { input: blob.stdout },
        );
      }
    }
    peon(['cp', `${source}/AGENTS.md`, `${trustedProtectedRoot}/AGENTS.md`]);
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
      { workspace: source, runCommand },
    ).fingerprint;
    const attemptNumber = 100000 + Math.floor(Math.random() * 800000);
    const attemptId = `issue-${issueNumber}-attempt-${attemptNumber}`;
    const privateCopy = preparePrivateSourceCopy({
      issueNumber,
      attemptId,
      workspace: source,
      privateRoot,
      expectedBranch: branch,
      expectedRevision,
      expectedFingerprint,
      authorizedChangePaths: ['libs'],
      protectedPaths: ['AGENTS.md'],
      runCommand,
      inspectWorkspace: (number, expected, base, config) =>
        inspectRestrictedWorkspace(number, expected, base, {
          ...config,
          runCommand,
        }),
    });
    peon([
      'python3',
      '-I',
      '-c',
      'import pathlib,sys; pathlib.Path(sys.argv[1]).write_text("inert\\n",encoding="utf-8")',
      `${privateCopy.privatePath}/libs/inert-probe.txt`,
    ]);
    if (expectFailure)
      peon([
        'python3',
        '-I',
        '-c',
        'import pathlib,sys; p=pathlib.Path(sys.argv[1]); p.write_text(p.read_text(encoding="utf-8")+"\\nit(\'inert failure\', () => { throw new Error(\'inert failure\'); });\\n",encoding="utf-8")',
        `${privateCopy.privatePath}/libs/ui/atoms/src/lib/atoms/button-atom.component.spec.ts`,
      ]);
    const options = {
      issueNumber,
      attemptNumber,
      privateCopy,
      privateRoot,
      candidateRoot,
      trustedProtectedRoot,
      testRoot,
      expectedRevision,
      expectedFingerprint,
      expectedBaselineDigest: privateCopy.contentDigest,
      authorizedChangePaths: ['libs'],
      protectedPaths: ['AGENTS.md'],
      uid: Number(peon(['id', '-u'])),
      gid: Number(peon(['id', '-g'])),
      workerCompletion: Promise.resolve(),
      cacheRoot:
        '/home/peon/stellar-dependency-cache/9f7d2f801be4f1c6bc6b9bea5c6a7a3ffe64e0b7ee69fab9a4a1b3a8cf4b5fc0',
      requireExactTestSource: true,
      checkNames: expectFailure
        ? ['ui-atoms-test']
        : [
            'nx-project-discovery',
            'ui-atoms-lint',
            'ui-atoms-test',
            'ui-atoms-build',
          ],
    };
    const candidate = await collectPrivateCandidate(options, {
      runCommand,
      confirmTermination: async () => ({ confirmed: true, state: 'absent' }),
    });
    const evidence = await runPrivateCandidateChecks(options, candidate, {
      runCommand,
    });
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
    assert.equal(evidence.candidateDigest, candidate.contentDigest);
    assert.equal(
      evidence.status,
      expectFailure ? 'tests-failed' : 'tests-passed',
    );
    assert.deepEqual(
      evidence.checks.map((check) => check.exitCode),
      expectFailure ? [1] : [0, 0, 0, 0],
    );
    const recorded = JSON.parse(
      peon(['cat', `${testRoot}/${attemptId}/evidence.json`]),
    );
    assert.deepEqual(recorded, evidence);
    peon(['test', '!', '-e', `${candidate.privatePath}/.git`]);
    peon(['test', '-d', `${testRoot}/${attemptId}/workspace/.git`]);
    assert.equal(
      peon(['git', '-C', `${testRoot}/${attemptId}/workspace`, 'remote']),
      '',
    );
    peon([
      'test',
      '!',
      '-e',
      `${testRoot}/${attemptId}/workspace/.git/objects/info/alternates`,
    ]);
    assert.equal(
      peon([
        'find',
        `${testRoot}/${attemptId}/workspace/.git`,
        '-path',
        '*/hooks/*',
        '-type',
        'f',
        '-print',
      ]),
      '',
    );
    assert.equal(peon(['git', '-C', source, 'status', '--porcelain']), '');
    peon(['test', '!', '-e', `${source}/libs/inert-probe.txt`], {
      maxBuffer: 1024,
    });
    assert.equal(
      peon(['cat', `${candidate.privatePath}/libs/inert-probe.txt`]),
      'inert',
    );
  } finally {
    const verifyName = `stellar-peon-verify-${issueNumber}-`;
    const running = peon(['podman', 'ps', '--format', '{{.Names}}']);
    if (running.split('\n').some((name) => name.startsWith(verifyName)))
      safeToRemove = false;
    if (safeToRemove && peon(['realpath', '--', scratch]) === scratch)
      peon(['rm', '-rf', '--', scratch], { timeout: 60_000, maxBuffer: 1024 });
    else
      process.stderr.write(`Preserved uncertain inert scratch: ${scratch}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
