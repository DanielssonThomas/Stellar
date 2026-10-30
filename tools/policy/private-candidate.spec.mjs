import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { preparePrivateSourceCopy } from './prepare-private-source.mjs';
import { inspectRestrictedWorkspace } from './run-restricted-worker.mjs';
import { trustedPeonWorkerImage } from './supervised-peon-run.mjs';
import {
  assertExactPrivateCandidate,
  buildPrivateVerificationArgs,
  collectPrivateCandidate,
  preparePrivateCandidateTestCopy,
  recordPrivateCandidateTestEvidence,
  verifyPrivateCandidate,
  verifyPrivateCandidateTestCopy,
} from './private-candidate.mjs';

const issueNumber = 147;
const branch = 'issue/147-inert-output';
const windows = process.platform === 'win32';

function runCommand(
  args,
  { input, timeout = 20_000, maxBuffer = 2 * 1024 * 1024 } = {},
) {
  const result = spawnSync(
    windows ? 'wsl.exe' : args[0],
    windows
      ? ['--distribution', 'Ubuntu', '--user', 'peon', '--exec', ...args]
      : args.slice(1),
    { input, timeout, maxBuffer, windowsHide: true },
  );
  if (result.error || result.status !== 0)
    throw new Error(`Disposable candidate command failed: ${args[0]}`);
  return result.stdout.toString('utf8');
}

function run(args, { input, expected = 0 } = {}) {
  const result = spawnSync(
    windows ? 'wsl.exe' : args[0],
    windows
      ? ['--distribution', 'Ubuntu', '--user', 'peon', '--exec', ...args]
      : args.slice(1),
    { input, timeout: 20_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, expected, `command failed: ${args[0]}`);
  return result.stdout.toString('utf8').trim();
}

function write(name, content) {
  run([
    'python3',
    '-I',
    '-c',
    'import pathlib,sys; p=pathlib.Path(sys.argv[1]); p.parent.mkdir(parents=True,exist_ok=True); p.write_text(sys.argv[2],encoding="utf-8")',
    name,
    content,
  ]);
}

async function fixture(t, extraFiles = 0) {
  const scratch = run([
    'mktemp',
    '-d',
    windows
      ? '/home/peon/stellar-candidate-test-XXXXXX'
      : '/tmp/stellar-candidate-test-XXXXXX',
  ]);
  assert.match(
    scratch,
    windows
      ? /^\/home\/peon\/stellar-candidate-test-[A-Za-z0-9]+$/
      : /^\/tmp\/stellar-candidate-test-[A-Za-z0-9]+$/,
  );
  t.after(() => {
    assert.equal(run(['realpath', '--', scratch]), scratch);
    run(['rm', '-rf', '--', scratch]);
  });
  const source = `${scratch}/source`;
  const privateRoot = `${scratch}/private`;
  const candidateRoot = `${scratch}/candidate`;
  const trustedProtectedRoot = `${scratch}/protected`;
  for (const directory of [
    source,
    privateRoot,
    candidateRoot,
    trustedProtectedRoot,
  ])
    run(['mkdir', '-m', '700', '--', directory]);
  write(`${source}/src/one.txt`, 'before\n');
  write(`${source}/src/remove.txt`, 'remove\n');
  write(`${source}/docs/stable.txt`, 'stable\n');
  write(`${source}/AGENTS.md`, 'protected\n');
  if (extraFiles)
    run([
      'python3',
      '-I',
      '-c',
      'import pathlib,sys; root=pathlib.Path(sys.argv[1]); count=int(sys.argv[2]); [(root/("long-"+"x"*60+f"{i:04d}.txt")).write_text("bounded\\n") for i in range(count)]',
      `${source}/src`,
      String(extraFiles),
    ]);
  write(`${trustedProtectedRoot}/AGENTS.md`, 'trusted guidance\n');
  run(['git', 'init', '--quiet', '-b', branch, source]);
  run(['git', '-C', source, 'add', '.']);
  run([
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
  const expectedRevision = run(['git', '-C', source, 'rev-parse', 'HEAD']);
  const expectedFingerprint = inspectRestrictedWorkspace(
    issueNumber,
    branch,
    undefined,
    { workspace: source, runCommand },
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
      runCommand,
      inspectWorkspace: (number, expected, base, config) =>
        inspectRestrictedWorkspace(number, expected, base, {
          ...config,
          runCommand,
        }),
    });
  const privateCopy = makeCopy(attemptNumber);
  const otherCopy = makeCopy(attemptNumber + 1);
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
    uid: Number(run(['id', '-u'])),
    gid: Number(run(['id', '-g'])),
    workerCompletion: Promise.resolve(),
  };
  const confirmTermination = async () => ({ confirmed: true, state: 'absent' });
  return {
    scratch,
    source,
    privateCopy,
    otherCopy,
    options,
    confirmTermination,
    adapters: { runCommand, confirmTermination },
  };
}

test('collects exact additions, modifications and deletions, then verifies the quarantined candidate', async (t) => {
  const {
    source,
    privateCopy,
    otherCopy,
    options,
    confirmTermination,
    adapters,
  } = await fixture(t);
  write(`${privateCopy.privatePath}/src/one.txt`, 'after\n');
  write(`${privateCopy.privatePath}/src/new.txt`, 'new\n');
  run(['rm', '--', `${privateCopy.privatePath}/src/remove.txt`]);
  const candidate = await collectPrivateCandidate(options, adapters);
  await assert.rejects(collectPrivateCandidate(options, adapters), /failed/i);
  assert.deepEqual(candidate.changes, [
    { path: 'src/new.txt', status: 'added' },
    { path: 'src/one.txt', status: 'modified' },
    { path: 'src/remove.txt', status: 'deleted' },
  ]);
  assert.equal(
    run(['cat', `${candidate.privatePath}/docs/stable.txt`]),
    'stable',
  );
  assert.equal(run(['cat', `${source}/src/one.txt`]), 'before');
  assert.equal(run(['cat', `${otherCopy.privatePath}/src/one.txt`]), 'before');
  assert.equal(
    run([
      'test',
      '!',
      '-e',
      `${options.candidateRoot}/${candidate.attemptId}/verification.json`,
    ]),
    '',
  );
  const args = buildPrivateVerificationArgs(options, candidate);
  assert.ok(args.includes(trustedPeonWorkerImage));
  assert.ok(args.includes('--network=none'));
  assert.ok(args.includes('--read-only'));
  assert.ok(
    args.some((arg) =>
      arg.includes(`src=${candidate.privatePath},dst=/workspace,ro`),
    ),
  );
  assert.ok(args.every((arg) => !arg.includes(`src=${source},`)));
  await assert.rejects(
    verifyPrivateCandidate(options, candidate, {
      launch: async () => ({ exitCode: 73, signal: null, error: undefined }),
      ...adapters,
    }),
    /verification failed/,
  );
  run([
    'test',
    '!',
    '-e',
    `${options.candidateRoot}/${candidate.attemptId}/verification.json`,
  ]);
  const evidence = await verifyPrivateCandidate(options, candidate, {
    launch: async () => ({ exitCode: 0, signal: null, error: undefined }),
    ...adapters,
  });
  assert.equal(evidence.candidateDigest, candidate.contentDigest);
  assert.equal(
    run([
      'test',
      '-f',
      `${options.candidateRoot}/${candidate.attemptId}/verification.json`,
    ]),
    '',
  );
});

test('rejects uncertain termination, stale identity, protected paths and unsafe worker entries', async (t) => {
  const { privateCopy, otherCopy, options, confirmTermination, adapters } =
    await fixture(t);
  await assert.rejects(
    collectPrivateCandidate(
      { ...options, workerCompletion: new Promise(() => {}) },
      {
        confirmTermination: async () => ({
          confirmed: false,
          state: 'running',
        }),
      },
    ),
    /completion is uncertain/,
  );
  await assert.rejects(
    collectPrivateCandidate(options, {
      ...adapters,
      confirmTermination: async () => ({ confirmed: false, state: 'running' }),
    }),
    /termination is unconfirmed/,
  );
  await assert.rejects(
    collectPrivateCandidate({ ...options, privateCopy: otherCopy }, adapters),
    /identity/,
  );
  await assert.rejects(
    collectPrivateCandidate(
      { ...options, expectedBaselineDigest: '0'.repeat(64) },
      adapters,
    ),
    /identity/,
  );
  write(`${privateCopy.privatePath}/AGENTS.md`, 'bad\n');
  await assert.rejects(collectPrivateCandidate(options, adapters), /failed/i);
  run(['rm', '--', `${privateCopy.privatePath}/AGENTS.md`]);
  run(['ln', '-s', '/etc/passwd', `${privateCopy.privatePath}/src/link.txt`]);
  await assert.rejects(collectPrivateCandidate(options, adapters), /failed/i);
  run(['rm', '--', `${privateCopy.privatePath}/src/link.txt`]);
  run([
    'ln',
    `${privateCopy.privatePath}/src/one.txt`,
    `${privateCopy.privatePath}/src/hard.txt`,
  ]);
  await assert.rejects(collectPrivateCandidate(options, adapters), /failed/i);
  run(['rm', '--', `${privateCopy.privatePath}/src/hard.txt`]);
  run(['mkfifo', `${privateCopy.privatePath}/src/pipe`]);
  await assert.rejects(collectPrivateCandidate(options, adapters), /failed/i);
  run(['rm', '--', `${privateCopy.privatePath}/src/pipe`]);
  run([
    'python3',
    '-I',
    '-c',
    'import sys; open(sys.argv[1],"wb").truncate(8388609)',
    `${privateCopy.privatePath}/src/oversized.bin`,
  ]);
  await assert.rejects(collectPrivateCandidate(options, adapters), /failed/i);
  run(['rm', '--', `${privateCopy.privatePath}/src/oversized.bin`]);
  await assert.rejects(
    collectPrivateCandidate(
      { ...options, authorizedChangePaths: ['../escape'] },
      adapters,
    ),
    /scope/i,
  );
  write(`${privateCopy.privatePath}/src/.git/config`, 'unsafe\n');
  await assert.rejects(collectPrivateCandidate(options, adapters), /failed/i);
});

test('rejects mutation during collection and leaves the candidate incomplete', async (t) => {
  const { privateCopy, options, adapters } = await fixture(t);
  write(`${privateCopy.privatePath}/src/one.txt`, 'changed\n');
  const injected = (args, call) => {
    if (args[4] !== 'collect') return runCommand(args, call);
    const needle = "write_file(output_fd, name, chunks, int(entry['mode'], 8))";
    const separator = call.input.indexOf(10);
    const sourceLength = Number(
      call.input.subarray(0, separator).toString('ascii'),
    );
    const source = call.input
      .subarray(separator + 1, separator + 1 + sourceLength)
      .toString('utf8');
    assert.ok(source.includes(needle));
    const replacement = `${needle}\n                            if name == 'src/one.txt':\n                                with open(${JSON.stringify(`${privateCopy.privatePath}/src/one.txt`)}, 'wb') as changed:\n                                    changed.write(b'mutated\\n')`;
    const modified = Buffer.from(source.replace(needle, replacement), 'utf8');
    const payload = call.input.subarray(separator + 1 + sourceLength);
    return runCommand(args, {
      ...call,
      input: Buffer.concat([
        Buffer.from(`${modified.length}\n`),
        modified,
        payload,
      ]),
    });
  };
  await assert.rejects(
    collectPrivateCandidate(options, { ...adapters, runCommand: injected }),
    /failed/i,
  );
  run([
    'test',
    '-f',
    `${options.candidateRoot}/${privateCopy.attemptId}/.incomplete`,
  ]);
  run([
    'test',
    '!',
    '-e',
    `${options.candidateRoot}/${privateCopy.attemptId}/verification.json`,
  ]);
});

test('frames a valid large baseline manifest through stdin instead of Windows argv', async (t) => {
  const { options, adapters } = await fixture(t, 280);
  const baselineBytes = Buffer.byteLength(
    JSON.stringify(options.privateCopy),
    'utf8',
  );
  assert.ok(baselineBytes > 32_000);
  const candidate = await collectPrivateCandidate(options, adapters);
  assert.equal(candidate.files.length, 283);
  assert.deepEqual(candidate.changes, []);
});

test('a substituted candidate or uncertain verifier cannot be accepted', async (t) => {
  const { privateCopy, options, adapters } = await fixture(t);
  write(`${privateCopy.privatePath}/src/one.txt`, 'changed\n');
  const candidate = await collectPrivateCandidate(options, adapters);
  await assert.rejects(
    verifyPrivateCandidate(options, candidate, {
      ...adapters,
      launch: async () => ({
        exitCode: null,
        signal: 'SIGTERM',
        error: new Error('timed out'),
      }),
      confirmTermination: async () => ({ confirmed: false, state: 'running' }),
    }),
    /termination is uncertain/,
  );
  run([
    'test',
    '!',
    '-e',
    `${options.candidateRoot}/${candidate.attemptId}/verification.json`,
  ]);
  write(`${candidate.privatePath}/src/one.txt`, 'tampered\n');
  await assert.rejects(
    verifyPrivateCandidate(options, candidate, {
      ...adapters,
      launch: async () => ({ exitCode: 0, signal: null }),
    }),
    /failed|changed/i,
  );
  run([
    'test',
    '!',
    '-e',
    `${options.candidateRoot}/${candidate.attemptId}/verification.json`,
  ]);
});

test('test preparation copies exact candidate bytes without changing the candidate', async (t) => {
  const { scratch, source, privateCopy, otherCopy, options, adapters } =
    await fixture(t);
  write(`${privateCopy.privatePath}/src/one.txt`, 'candidate\n');
  const candidate = await collectPrivateCandidate(options, adapters);
  const testRoot = `${scratch}/tests`;
  run(['mkdir', '-m', '700', '--', testRoot]);
  const { testPath } = preparePrivateCandidateTestCopy(
    options,
    candidate,
    testRoot,
    adapters.runCommand,
  );
  assert.equal(run(['cat', `${testPath}/src/one.txt`]), 'candidate');
  assert.equal(run(['cat', `${source}/src/one.txt`]), 'before');
  run(['test', '!', '-e', `${candidate.privatePath}/.git`]);
  assertExactPrivateCandidate(options, candidate, adapters.runCommand);
  const evidence = {
    schema: 'stellar.private-repository-tests/v1',
    attemptId: candidate.attemptId,
    candidateDigest: candidate.contentDigest,
    integrity: 'verified',
    dependencyStatus: 'available',
    status: 'tests-failed',
    checks: [{ name: 'ui-atoms-test', exitCode: 1 }],
  };
  recordPrivateCandidateTestEvidence(
    options,
    candidate,
    testRoot,
    evidence,
    adapters.runCommand,
  );
  assert.deepEqual(
    JSON.parse(
      run(['cat', `${testRoot}/${candidate.attemptId}/evidence.json`]),
    ),
    evidence,
  );
  assert.throws(
    () =>
      recordPrivateCandidateTestEvidence(
        options,
        candidate,
        testRoot,
        evidence,
        adapters.runCommand,
      ),
    /failed/i,
  );
  assert.throws(
    () =>
      preparePrivateCandidateTestCopy(
        options,
        candidate,
        testRoot,
        adapters.runCommand,
      ),
    /failed/i,
  );
  write(`${otherCopy.privatePath}/src/one.txt`, 'other attempt\n');
  const otherOptions = {
    ...options,
    attemptNumber: options.attemptNumber + 1,
    privateCopy: otherCopy,
    expectedBaselineDigest: otherCopy.contentDigest,
  };
  const otherCandidate = await collectPrivateCandidate(otherOptions, adapters);
  const otherTest = preparePrivateCandidateTestCopy(
    otherOptions,
    otherCandidate,
    testRoot,
    adapters.runCommand,
  );
  assert.notEqual(otherTest.testPath, testPath);
  assert.equal(
    run(['cat', `${otherTest.testPath}/src/one.txt`]),
    'other attempt',
  );
  assert.equal(run(['cat', `${testPath}/src/one.txt`]), 'candidate');
  write(`${candidate.privatePath}/src/one.txt`, 'mutated after copy\n');
  assert.throws(
    () => assertExactPrivateCandidate(options, candidate, adapters.runCommand),
    /failed|changed/i,
  );
});

test('disposable test verification rejects changed and extra executable inputs', async (t) => {
  const { scratch, privateCopy, options, adapters } = await fixture(t);
  write(`${privateCopy.privatePath}/src/one.txt`, 'candidate\n');
  const candidate = await collectPrivateCandidate(options, adapters);
  const testRoot = `${scratch}/tests`;
  run(['mkdir', '-m', '700', '--', testRoot]);
  const { testPath } = preparePrivateCandidateTestCopy(
    options,
    candidate,
    testRoot,
    adapters.runCommand,
  );
  verifyPrivateCandidateTestCopy(
    options,
    candidate,
    testRoot,
    adapters.runCommand,
  );
  write(`${testPath}/src/one.txt`, 'substituted\n');
  assert.throws(
    () =>
      verifyPrivateCandidateTestCopy(
        options,
        candidate,
        testRoot,
        adapters.runCommand,
      ),
    /failed/i,
  );
  write(`${testPath}/src/one.txt`, 'candidate\n');
  write(`${testPath}/vitest.config.ts`, 'export default {};\n');
  assert.throws(
    () =>
      verifyPrivateCandidateTestCopy(
        options,
        candidate,
        testRoot,
        adapters.runCommand,
      ),
    /failed/i,
  );
  run(['rm', '--', `${testPath}/vitest.config.ts`]);
  run(['ln', '-s', 'one.txt', `${testPath}/src/alias.txt`]);
  assert.throws(
    () =>
      verifyPrivateCandidateTestCopy(
        options,
        candidate,
        testRoot,
        adapters.runCommand,
      ),
    /failed/i,
  );
  assertExactPrivateCandidate(options, candidate, adapters.runCommand);
});
