import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readHandoff, superviseWorker } from './supervise-worker.mjs';
import {
  runSupervisedPeonIssue,
  trustedPeonWorkerImage,
  validateLivePeonAssignment,
} from './supervised-peon-run.mjs';

const image = trustedPeonWorkerImage;
const sessionId = 'peon-issue-50-controlled-trial';
const root = await mkdtemp(join(tmpdir(), 'stellar-live-supervisor-'));
const handoffPath = join(root, 'handoff.json');

const issue = {
  number: 50,
  state: 'OPEN',
  body: [
    '## Objective',
    'One task.',
    '## Expected outcome',
    'One observable result.',
    '## Acceptance criteria',
    '- [ ] Implement the expected result.',
    '## Constraints',
    'Keep scope small.',
    '## Dependencies',
    'None',
    '## Verification expectations',
    'Run focused checks.',
  ].join('\n'),
  labels: [
    'priority:low',
    'target:develop',
    'type:feature',
    'status:in-progress',
    'worker:peon',
  ],
  dependencies: [],
};

function claim(overrides = {}) {
  return {
    state: 'active',
    worker: 'worker:peon',
    sessionId,
    target: 'develop',
    branch: 'issue/50-avatar-skeleton',
    worktreePath: join(root, 'issue-50'),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

test('validates issue metadata, closed dependencies, claim, and immutable image before launch', () => {
  const task = validateLivePeonAssignment({
    issue,
    claim: claim(),
    sessionId,
    image,
  });

  assert.deepEqual(task, {
    issueNumber: 50,
    owner: 'worker:peon',
    targetBranch: 'develop',
    branch: 'issue/50-avatar-skeleton',
    worktreePath: join(root, 'issue-50'),
  });
  assert.throws(
    () =>
      validateLivePeonAssignment({
        issue,
        claim: claim({ sessionId: 'another-session' }),
        sessionId,
        image,
      }),
    /active issue claim/,
  );
  assert.throws(
    () =>
      validateLivePeonAssignment({
        issue: {
          ...issue,
          body: issue.body.replace(
            '## Dependencies\nNone',
            '## Dependencies\n#43',
          ),
          dependencies: [{ number: 43, state: 'OPEN' }],
        },
        claim: claim(),
        sessionId,
        image,
      }),
    /dependencies must be closed/,
  );
  assert.throws(
    () =>
      validateLivePeonAssignment({
        issue,
        claim: claim(),
        sessionId,
        image: 'latest',
      }),
    /pinned worker image/,
  );
  assert.throws(
    () =>
      validateLivePeonAssignment({
        issue,
        claim: claim(),
        sessionId,
        image: `ghcr.io/stellar-ai-corp/hermes-worker@sha256:${'a'.repeat(64)}`,
      }),
    /trusted worker image digest/,
  );
});

test('does not create the live worker until the current assignment is valid', async () => {
  let workerCreated = false;
  await assert.rejects(
    runSupervisedPeonIssue({
      issueNumber: 50,
      sessionId: 'wrong-session',
      image,
      repositoryRoot: root,
      handoffPath,
      verificationCommands: [{ name: 'unit-tests', command: ['pnpm', 'test'] }],
      loadAssignment: async () => issue,
      readClaim: async () => claim(),
      inspectWorktree: async () => ({ fingerprint: 'clean', changes: [] }),
      createWorkerAdapter: () => {
        workerCreated = true;
      },
    }),
    /active issue claim/,
  );
  assert.equal(workerCreated, false);
});

test('rejects incompatible images before worker creation and supervision', async () => {
  let workerCreated = false;
  let supervisorStarted = false;
  let verificationStarted = false;
  let inspectedImage;

  await assert.rejects(
    runSupervisedPeonIssue({
      issueNumber: 50,
      sessionId,
      image,
      repositoryRoot: root,
      handoffPath,
      verificationCommands: [{ name: 'unit-tests', command: ['pnpm', 'test'] }],
      loadAssignment: async () => issue,
      readClaim: async () => claim(),
      inspectWorktree: async () => ({ fingerprint: 'clean', changes: [] }),
      verifyImageCompatibility: async (input) => {
        inspectedImage = input.image;
        throw new Error(
          'Pinned worker image is incompatible: metering proxy hashes differ.',
        );
      },
      createWorkerAdapter: () => {
        workerCreated = true;
      },
      runSupervisor: async () => {
        supervisorStarted = true;
      },
      runVerification: async () => {
        verificationStarted = true;
      },
    }),
    /Pinned worker image is incompatible/,
  );

  assert.equal(inspectedImage, image);
  assert.equal(workerCreated, false);
  assert.equal(supervisorStarted, false);
  assert.equal(verificationStarted, false);
});

test('wires one live attempt to the deterministic supervisor and isolated verifier', async () => {
  let options;
  let verification;
  let canceled = false;
  let resolveVerification;
  const result = await runSupervisedPeonIssue({
    issueNumber: 50,
    sessionId,
    image,
    repositoryRoot: root,
    handoffPath,
    verificationCommands: [
      { name: 'unit-tests', command: ['corepack', 'pnpm', 'test'] },
    ],
    loadAssignment: async () => issue,
    readClaim: async () => claim(),
    inspectWorktree: async () => ({ fingerprint: 'clean', changes: [] }),
    verifyImageCompatibility: async () => ({
      sourceSha256: 'a',
      imageSha256: 'a',
    }),
    createWorkerAdapter: ({ image: selectedImage }) => ({
      id: 'peon',
      run: async () => ({ status: 'completed' }),
      usage: async () => ({ toolCalls: 0, modelTokens: 0 }),
      cancel: async () => true,
      selectedImage,
    }),
    runVerification: async (input) => {
      verification = input;
      return new Promise((resolve) => {
        resolveVerification = resolve;
      });
    },
    cancelVerification: async () => {
      canceled = true;
      resolveVerification({ exitCode: 1 });
      return true;
    },
    runSupervisor: async (input) => {
      options = input;
      const pendingChecks = input.verify({
        task: input.task,
        attemptNumber: 1,
      });
      await input.verify.cancel();
      const checks = await pendingChecks;
      return { status: 'complete', checks };
    },
  });

  assert.equal(result.status, 'complete');
  assert.equal(options.task.branch, 'issue/50-avatar-skeleton');
  assert.equal(options.limits.maxAttemptsPerWorker, 1);
  assert.equal(options.limits.maxToolCallsPerWorker, 64);
  assert.equal(options.limits.maxModelTokensPerWorker, 32_000);
  assert.equal(options.authorizeHandoff, undefined);
  assert.equal(options.workers.peon.selectedImage, image);
  assert.equal(options.workers.mira.id, 'mira');
  assert.equal(verification.image, image);
  assert.deepEqual(verification.command, ['corepack', 'pnpm', 'test']);
  assert.equal(canceled, true);
  assert.equal(result.checks[0].passed, false);
});

test('requires named trusted verification commands and an absolute handoff path', async () => {
  const input = {
    issueNumber: 50,
    sessionId,
    image,
    repositoryRoot: root,
    handoffPath,
    verificationCommands: [],
    loadAssignment: async () => issue,
    readClaim: async () => claim(),
  };
  await assert.rejects(runSupervisedPeonIssue(input), /verification commands/);
  await assert.rejects(
    runSupervisedPeonIssue({
      ...input,
      handoffPath: 'relative/handoff.json',
      verificationCommands: [{ name: 'checks', command: ['pnpm', 'test'] }],
    }),
    /absolute handoff path/,
  );
});

test('stops a live adapter at the metered tool budget and persists a handoff', async () => {
  let stopped = false;
  const budgetHandoff = join(root, 'budget-handoff.json');
  const result = await runSupervisedPeonIssue({
    issueNumber: 50,
    sessionId,
    image,
    repositoryRoot: root,
    handoffPath: budgetHandoff,
    verificationCommands: [{ name: 'unit-tests', command: ['pnpm', 'test'] }],
    loadAssignment: async () => issue,
    readClaim: async () => claim(),
    inspectWorktree: async () => ({ fingerprint: 'clean', changes: [] }),
    verifyImageCompatibility: async () => ({
      sourceSha256: 'a',
      imageSha256: 'a',
    }),
    createWorkerAdapter: () => ({
      id: 'peon',
      run: ({ signal }) =>
        new Promise((resolve) => {
          signal.addEventListener(
            'abort',
            () => resolve({ status: 'failed' }),
            { once: true },
          );
        }),
      usage: async () => ({
        toolCalls: 65,
        modelTokens: 100,
        exceededResource: 'tool-calls',
      }),
      cancel: async () => {
        stopped = true;
        return true;
      },
    }),
    runSupervisor: superviseWorker,
  });

  assert.equal(result.status, 'handoff-pending');
  assert.equal(stopped, true);
  const handoff = await readHandoff(budgetHandoff);
  assert.equal(handoff.status, 'handoff-pending');
  assert.equal(handoff.attempts[0].failure.code, 'ResourceLimit');
  assert.equal(handoff.attempts[0].toolCalls, 65);
});

test('stops and preserves a handoff when the live usage channel fails', async () => {
  let stopped = false;
  const failureHandoff = join(root, 'usage-failure-handoff.json');
  const result = await runSupervisedPeonIssue({
    issueNumber: 50,
    sessionId,
    image,
    repositoryRoot: root,
    handoffPath: failureHandoff,
    verificationCommands: [{ name: 'unit-tests', command: ['pnpm', 'test'] }],
    loadAssignment: async () => issue,
    readClaim: async () => claim(),
    inspectWorktree: async () => ({ fingerprint: 'clean', changes: [] }),
    verifyImageCompatibility: async () => ({
      sourceSha256: 'a',
      imageSha256: 'a',
    }),
    createWorkerAdapter: () => ({
      id: 'peon',
      run: ({ signal }) =>
        new Promise((resolve) => {
          signal.addEventListener(
            'abort',
            () => resolve({ status: 'failed' }),
            { once: true },
          );
        }),
      usage: async () => {
        throw new Error('meter unavailable');
      },
      cancel: async () => {
        stopped = true;
        return true;
      },
    }),
    runSupervisor: superviseWorker,
  });

  assert.equal(result.status, 'handoff-pending');
  assert.equal(stopped, true);
  const handoff = JSON.parse(await readFile(failureHandoff, 'utf8'));
  assert.equal(handoff.status, 'handoff-pending');
  assert.equal(handoff.attempts[0].failure.code, 'UsageAccountingFailure');
});

test.after(async () => rm(root, { recursive: true, force: true }));
