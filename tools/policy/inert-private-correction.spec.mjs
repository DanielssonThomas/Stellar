import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildInertPrivateArgs,
  measureInertAttemptDisk,
  recoverInertPrivateCorrection,
  runInertPrivateCorrection,
} from './inert-private-correction.mjs';
import {
  correctionFeedbackFromHandoff,
  readHandoff,
  recordInertCorrectionResult,
} from './supervise-worker.mjs';
import { trustedPeonWorkerImage } from './supervised-peon-run.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const issueNumber = 151;
const revision = 'a'.repeat(40);
const sourceFingerprint = 'b'.repeat(64);
const feedbackFingerprint = sha(sourceFingerprint);
const attemptId = 'issue-151-attempt-2';
const sourceWorkspace = '/home/peon/inert-correction-fixture/source';
const privateRoot = '/home/peon/inert-correction-fixture/private';
const candidateRoot = '/home/peon/inert-correction-fixture/candidate';
const testRoot = '/home/peon/inert-correction-fixture/tests';
const trustedProtectedRoot = '/home/peon/inert-correction-fixture/protected';
const baseDisk = { privateRoot, candidateRoot, testRoot, attemptId };

async function fixture(t) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'stellar-151-'));
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(parent, { recursive: true, force: true });
  });
  const repositoryRoot = path.join(parent, 'repo');
  await mkdir(repositoryRoot);
  const handoffPath = path.join(parent, 'handoff.json');
  const task = {
    issueNumber,
    owner: 'owner:codex',
    targetBranch: 'develop',
    branch: 'issue/151-inert-fixture',
    worktreePath: repositoryRoot,
  };
  const failure = { code: 'TestFailure', message: 'Inert prior failure.' };
  const handoff = {
    schemaVersion: 1,
    task,
    status: 'paused',
    safeToResume: true,
    executionOwner: 'inert-fixture-owner',
    supervisorRevision: 0,
    updatedAt: new Date().toISOString(),
    attempts: [
      {
        workerId: 'peon',
        attemptNumber: 1,
        afterFingerprint: feedbackFingerprint,
        failure,
      },
    ],
    mentorFeedback: [
      {
        issueNumber,
        attemptNumber: 1,
        level: 'diagnostic',
        fingerprint: feedbackFingerprint,
        resultFingerprint: feedbackFingerprint,
        supervisorRevision: 0,
        executionOwner: 'inert-fixture-owner',
        taskOwner: task.owner,
        attemptCount: 1,
        evidence: {
          kind: 'failure',
          fingerprint: sha(JSON.stringify(failure)),
        },
        diagnostic: 'Inert prior failure.',
      },
    ],
  };
  await writeFile(handoffPath, `${JSON.stringify(handoff)}\n`);
  const options = {
    repositoryRoot,
    issueNumber,
    sessionId: 'fixture-session',
    handoffPath,
    sourceWorkspace,
    privateRoot,
    candidateRoot,
    testRoot,
    trustedProtectedRoot,
    authorizedChangePaths: ['libs'],
    protectedPaths: ['AGENTS.md'],
    writablePaths: ['libs'],
    editPath: 'libs/inert-probe.txt',
    hermesConfigSource:
      '/mnt/d/ai-repositories/stellar/tools/policy/peon-hermes-narrow-config.yaml',
    minimalGuidanceSource:
      '/mnt/d/ai-repositories/stellar/tools/policy/peon-coding-agents.md',
    cacheRoot:
      '/home/peon/stellar-dependency-cache/d58b1d779f62119bfc1d38a264a7ca1ca779488beff9f06d882cd0a1cc6ecee5',
    checkNames: ['nx-project-discovery'],
  };
  const authority = {
    issue: {
      number: issueNumber,
      state: 'OPEN',
      labels: ['status:in-progress', 'owner:codex', 'target:develop'],
    },
    claim: {
      state: 'active',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      worker: 'owner:codex',
      sessionId: options.sessionId,
      branch: task.branch,
      target: 'develop',
      worktreePath: repositoryRoot,
    },
  };
  const privateCopy = {
    schema: 'stellar.private-source/v1',
    attemptId,
    sourceRevision: revision,
    sourceFingerprint,
    contentDigest: 'c'.repeat(64),
    files: [],
    privatePath: `${privateRoot}/${attemptId}/workspace`,
  };
  const candidate = {
    schema: 'stellar.private-candidate/v1',
    attemptId,
    sourceRevision: revision,
    sourceFingerprint,
    baselineDigest: privateCopy.contentDigest,
    contentDigest: 'd'.repeat(64),
    privatePath: `${candidateRoot}/${attemptId}/workspace`,
    files: [],
    changes: ['libs/inert-probe.txt'],
  };
  const manifest = { ...privateCopy };
  delete manifest.privatePath;
  const runCommand = (args) => {
    if (args[0] === 'df') return 'Avail\n10000000000\n';
    if (args[0] === 'du') return '10000\tpath\n';
    if (args[0] === 'realpath') return args.at(-1);
    if (args[0] === 'id') return '1001\n';
    if (args[0] === 'python3') return JSON.stringify(manifest);
    throw new Error(`Unexpected trusted command: ${args[0]}`);
  };
  const adapters = {
    inspectAuthority: async () => authority,
    inspectWorkspace: async () => ({
      headRevision: revision,
      fingerprint: sourceFingerprint,
      changes: [],
    }),
    inspectContainer: async () => 'absent',
    confirmTermination: async () => ({ confirmed: true, state: 'absent' }),
    runCommand,
    prepareSource: async () => privateCopy,
    launchWorker: async () => ({ exitCode: 0, signal: null }),
    collect: async () => candidate,
    runChecks: async (_options, _candidate, { onPhase }) => {
      await onPhase('git-prepared');
      return {
        attemptId,
        candidateDigest: candidate.contentDigest,
        integrity: 'verified',
        status: 'tests-passed',
      };
    },
  };
  return {
    parent,
    repositoryRoot,
    handoffPath,
    task,
    options,
    authority,
    privateCopy,
    candidate,
    adapters,
  };
}

test('fixed inert worker arguments deny model network, secrets and arbitrary execution', () => {
  const workspace = `${privateRoot}/${attemptId}/workspace`;
  const mount = {
    workspace,
    args: [
      'run',
      '--pull=never',
      '--read-only',
      '--cap-drop=all',
      '--network=peon-worker',
      `--mount=type=bind,src=${workspace},dst=/workspace,ro`,
      trustedPeonWorkerImage,
      'hermes',
      'chat',
    ],
  };
  const args = buildInertPrivateArgs(mount, 'success', 'libs/inert-probe.txt');
  assert.ok(args.includes('--network=none'));
  assert.ok(!args.includes('--network=peon-worker'));
  assert.ok(!args.includes('hermes'));
  assert.ok(args.includes('--entrypoint=python3'));
  assert.throws(
    () => buildInertPrivateArgs(mount, 'shell', 'libs/x'),
    /fixed inert/,
  );
  assert.throws(
    () =>
      buildInertPrivateArgs(
        {
          ...mount,
          args: [
            ...mount.args.slice(0, -3),
            '--secret=source=token',
            ...mount.args.slice(-3),
          ],
        },
        'success',
        'libs/x',
      ),
    /credentials/,
  );
});

test('disk policy rejects unsafe roots, exhaustion and low free space', () => {
  const runCommand = (args) =>
    args[0] === 'df'
      ? 'Avail\n5000000000'
      : args[0] === 'realpath'
        ? args.at(-1)
        : '10000\tpath';
  const measured = measureInertAttemptDisk({
    ...baseDisk,
    existing: ['privateRoot', 'candidateRoot', 'testRoot'],
    runCommand,
  });
  assert.equal(measured.usedBytes, 30000);
  assert.throws(
    () =>
      measureInertAttemptDisk({
        ...baseDisk,
        testRoot: privateRoot,
        runCommand,
      }),
    /disk roots/,
  );
  assert.throws(
    () =>
      measureInertAttemptDisk({
        ...baseDisk,
        runCommand: () => 'Avail\n3000000000',
      }),
    /disk budget/,
  );
  assert.throws(
    () =>
      measureInertAttemptDisk({
        ...baseDisk,
        existing: ['privateRoot'],
        runCommand: (args) =>
          args[0] === 'df'
            ? 'Avail\n10000000000'
            : args[0] === 'realpath'
              ? args.at(-1)
              : `${3 * 1024 ** 3 + 1}\tpath`,
      }),
    /disk budget/,
  );
});

test('inert lifecycle records a separate result and never credits a Peon attempt', async (t) => {
  const f = await fixture(t);
  const result = await runInertPrivateCorrection(f.options, f.adapters);
  assert.equal(result.status, 'tests-passed');
  assert.equal(result.attribution, 'inert-simulation');
  assert.deepEqual(result.usage, {
    modelTokens: 0,
    toolCalls: 0,
    source: 'inert-no-model',
  });
  const handoff = await readHandoff(f.handoffPath);
  assert.equal(handoff.attempts.length, 1);
  assert.equal(handoff.mentorFeedback.length, 1);
  assert.equal(handoff.inertCorrectionResults[0].status, 'tests-passed');
  assert.equal(
    handoff.inertCorrectionResults[0].attribution,
    'inert-simulation',
  );
  await assert.rejects(
    correctionFeedbackFromHandoff({
      handoffPath: f.handoffPath,
      issueNumber,
      inspectWorktree: async () => ({ fingerprint: sourceFingerprint }),
    }),
    /superseded|unsafe/,
  );
  const stateRoot = path.join(
    f.parent,
    '.stellar-supervisor-state',
    'inert-correction',
  );
  await assert.rejects(readFile(path.join(stateRoot, 'active.json')), /ENOENT/);
  assert.equal(
    JSON.parse(
      await readFile(path.join(stateRoot, `${attemptId}.json`), 'utf8'),
    ).status,
    'tests-passed',
  );
});

test('stale ownership, source mutation and duplicate active reservation fail before launch', async (t) => {
  const f = await fixture(t);
  let launches = 0;
  f.adapters.launchWorker = async () => {
    launches += 1;
    return { exitCode: 0 };
  };
  f.authority.claim.sessionId = 'other-session';
  await assert.rejects(
    runInertPrivateCorrection(f.options, f.adapters),
    /stale/,
  );
  f.authority.claim.sessionId = f.options.sessionId;
  f.authority.claim.expiresAt = new Date(Date.now() - 1000).toISOString();
  await assert.rejects(
    runInertPrivateCorrection(f.options, f.adapters),
    /stale/,
  );
  f.authority.claim.expiresAt = new Date(Date.now() + 60_000).toISOString();
  f.authority.issue.dependencies = [
    { state: 'OPEN', status: 'status:in-progress' },
  ];
  await assert.rejects(
    runInertPrivateCorrection(f.options, f.adapters),
    /stale/,
  );
  f.authority.issue.dependencies = [];
  f.adapters.inspectContainer = async (name) =>
    name === 'stellar-peon-worker-151-1' ? 'running' : 'absent';
  await assert.rejects(
    runInertPrivateCorrection(f.options, f.adapters),
    /Prior Peon worker/,
  );
  f.adapters.inspectContainer = async () => 'absent';
  f.adapters.inspectWorkspace = async () => ({
    headRevision: revision,
    fingerprint: 'changed',
    changes: [],
  });
  await assert.rejects(
    runInertPrivateCorrection(f.options, f.adapters),
    /changed|stale/,
  );
  f.adapters.inspectWorkspace = async () => ({
    headRevision: revision,
    fingerprint: sourceFingerprint,
    changes: [],
  });
  const stateRoot = path.join(
    f.parent,
    '.stellar-supervisor-state',
    'inert-correction',
  );
  await mkdir(stateRoot, { recursive: true });
  await writeFile(path.join(stateRoot, 'active.json'), '{}\n');
  await assert.rejects(
    runInertPrivateCorrection(f.options, f.adapters),
    /EEXIST/,
  );
  assert.equal(launches, 0);
});

test('wrong candidate digest and uncertain termination stay quarantined for exact recovery', async (t) => {
  const f = await fixture(t);
  f.adapters.collect = async () => ({
    ...f.candidate,
    contentDigest: 'invalid',
  });
  await assert.rejects(
    runInertPrivateCorrection(f.options, f.adapters),
    /candidate identity/,
  );
  const stateRoot = path.join(
    f.parent,
    '.stellar-supervisor-state',
    'inert-correction',
  );
  const activePath = path.join(stateRoot, 'active.json');
  assert.equal(
    JSON.parse(await readFile(activePath, 'utf8')).attemptId,
    attemptId,
  );
  await assert.rejects(
    recoverInertPrivateCorrection({
      repositoryRoot: f.repositoryRoot,
      attemptId,
      confirmSupervisorStopped: async () => false,
      confirmTermination: async () => ({ confirmed: true, state: 'absent' }),
    }),
    /supervisor termination/,
  );
  await assert.rejects(
    recoverInertPrivateCorrection({
      repositoryRoot: f.repositoryRoot,
      attemptId,
      confirmSupervisorStopped: async () => true,
      confirmTermination: async () => ({ confirmed: false, state: 'running' }),
    }),
    /confirmed/,
  );
  assert.equal(
    JSON.parse(await readFile(activePath, 'utf8')).attemptId,
    attemptId,
  );
  const recovered = await recoverInertPrivateCorrection({
    repositoryRoot: f.repositoryRoot,
    attemptId,
    confirmSupervisorStopped: async () => true,
    confirmTermination: async () => ({ confirmed: true, state: 'absent' }),
  });
  assert.equal(recovered.status, 'recovered-quarantined');
  assert.equal(recovered.artifactsRetained, true);
  await assert.rejects(readFile(activePath), /ENOENT/);
});

test('recording cannot turn a duplicate simulation into Peon learning', async (t) => {
  const f = await fixture(t);
  const result = {
    schema: 'stellar.inert-correction-result/v1',
    issueNumber,
    attemptId,
    attribution: 'inert-simulation',
    status: 'failed',
    candidateDigest: 'none',
  };
  await assert.rejects(
    recordInertCorrectionResult({
      handoffPath: f.handoffPath,
      issueNumber,
      expectedFingerprint: feedbackFingerprint,
      result: { ...result, attemptId: 'issue-151-attempt-3' },
      inspectWorktree: async () => ({ fingerprint: sourceFingerprint }),
    }),
    /attempt changed/,
  );
  await recordInertCorrectionResult({
    handoffPath: f.handoffPath,
    issueNumber,
    expectedFingerprint: feedbackFingerprint,
    result,
    inspectWorktree: async () => ({ fingerprint: sourceFingerprint }),
  });
  await assert.rejects(
    recordInertCorrectionResult({
      handoffPath: f.handoffPath,
      issueNumber,
      expectedFingerprint: feedbackFingerprint,
      result,
      inspectWorktree: async () => ({ fingerprint: sourceFingerprint }),
    }),
    /superseded|unsafe|changed/,
  );
  assert.equal((await readHandoff(f.handoffPath)).attempts.length, 1);
});

test('recovery preserves a completed result when release was interrupted', async (t) => {
  const f = await fixture(t);
  await runInertPrivateCorrection(f.options, f.adapters);
  const stateRoot = path.join(
    f.parent,
    '.stellar-supervisor-state',
    'inert-correction',
  );
  const journal = JSON.parse(
    await readFile(path.join(stateRoot, `${attemptId}.json`), 'utf8'),
  );
  await writeFile(
    path.join(stateRoot, 'active.json'),
    `${JSON.stringify(journal)}\n`,
  );
  const recovered = await recoverInertPrivateCorrection({
    repositoryRoot: f.repositoryRoot,
    attemptId,
    confirmSupervisorStopped: async () => true,
    confirmTermination: async () => ({ confirmed: true, state: 'absent' }),
  });
  assert.equal(recovered.status, 'recovered-complete');
  assert.equal(
    (await readHandoff(f.handoffPath)).inertCorrectionResults.length,
    1,
  );
});

test('a released active marker cannot permit replay of an existing attempt journal', async (t) => {
  const f = await fixture(t);
  const original = await readFile(f.handoffPath, 'utf8');
  await runInertPrivateCorrection(f.options, f.adapters);
  await writeFile(f.handoffPath, original);
  await assert.rejects(
    runInertPrivateCorrection(f.options, f.adapters),
    /Duplicate inert attempt/,
  );
  const stateRoot = path.join(
    f.parent,
    '.stellar-supervisor-state',
    'inert-correction',
  );
  await assert.rejects(readFile(path.join(stateRoot, 'active.json')), /ENOENT/);
  assert.equal(
    JSON.parse(
      await readFile(path.join(stateRoot, `${attemptId}.json`), 'utf8'),
    ).status,
    'tests-passed',
  );
});

test('cancellation and timeout confirm termination without collection or Peon credit', async (t) => {
  for (const field of ['cancelled', 'timedOut']) {
    const f = await fixture(t);
    let collections = 0;
    f.adapters.launchWorker = async () => ({
      exitCode: null,
      signal: 'SIGTERM',
      [field]: true,
    });
    f.adapters.collect = async () => {
      collections += 1;
      throw new Error('Must not collect.');
    };
    const result = await runInertPrivateCorrection(f.options, f.adapters);
    assert.equal(
      result.status,
      field === 'cancelled' ? 'cancelled' : 'timeout',
    );
    assert.equal(collections, 0);
    assert.equal((await readHandoff(f.handoffPath)).attempts.length, 1);
  }
});

test('worker and dependency failures cannot be reported as passed repository tests', async (t) => {
  for (const failure of ['worker', 'dependencies']) {
    const f = await fixture(t);
    if (failure === 'worker')
      f.adapters.launchWorker = async () => ({ exitCode: 17 });
    else
      f.adapters.runChecks = async () => ({
        attemptId,
        candidateDigest: f.candidate.contentDigest,
        integrity: 'verified',
        status: 'dependencies-unavailable',
      });
    const result = await runInertPrivateCorrection(f.options, f.adapters);
    assert.equal(
      result.status,
      failure === 'worker' ? 'worker-failed' : 'dependencies-unavailable',
    );
    assert.equal(
      (await readHandoff(f.handoffPath)).inertCorrectionResults[0].status,
      result.status,
    );
  }
});

test('projected attempt-local cache copy is denied before dependency preparation', async (t) => {
  const f = await fixture(t);
  f.adapters.runChecks = async (_options, _candidate, { onPhase }) => {
    await onPhase('cache-preflight', { cacheSize: 3 * 1024 ** 3 });
    throw new Error('Copy must not start.');
  };
  await assert.rejects(
    runInertPrivateCorrection(f.options, f.adapters),
    /cache copy exceeds/,
  );
  assert.equal((await readHandoff(f.handoffPath)).attempts.length, 1);
});

test('source mutation during preparation quarantines and blocks a subsequent attempt', async (t) => {
  const f = await fixture(t);
  let launches = 0;
  let fingerprint = sourceFingerprint;
  f.adapters.inspectWorkspace = async () => ({
    headRevision: revision,
    fingerprint,
    changes: [],
  });
  f.adapters.prepareSource = async () => {
    fingerprint = 'c'.repeat(64);
    return f.privateCopy;
  };
  f.adapters.launchWorker = async () => {
    launches += 1;
    return { exitCode: 0 };
  };
  await assert.rejects(
    runInertPrivateCorrection(f.options, f.adapters),
    /source changed|Correction source/,
  );
  assert.equal(launches, 0);
  const active = path.join(
    f.parent,
    '.stellar-supervisor-state',
    'inert-correction',
    'active.json',
  );
  assert.equal(JSON.parse(await readFile(active, 'utf8')).attemptId, attemptId);
  await assert.rejects(
    runInertPrivateCorrection(f.options, f.adapters),
    /source changed|Correction source/,
  );
});

test('failed verifier remains quarantined and wrong attempt recovery is denied', async (t) => {
  const f = await fixture(t);
  f.adapters.runChecks = async () => {
    throw new Error('Verifier container failed.');
  };
  await assert.rejects(
    runInertPrivateCorrection(f.options, f.adapters),
    /Verifier container failed/,
  );
  await assert.rejects(
    recoverInertPrivateCorrection({
      repositoryRoot: f.repositoryRoot,
      attemptId: 'issue-151-attempt-3',
      confirmSupervisorStopped: async () => true,
      confirmTermination: async () => ({ confirmed: true, state: 'absent' }),
    }),
    /differs/,
  );
  assert.equal((await readHandoff(f.handoffPath)).attempts.length, 1);
});
