import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  parsePilotArguments,
  runPilotOperation,
  validatePilotEvidence,
  validatePinnedImageId,
} from './run-issue-138-pilot.mjs';
import { trustedPeonWorkerImage } from './supervised-peon-run.mjs';

const revision = 'a'.repeat(40);
const fingerprint = 'b'.repeat(64);
const issueDigest = 'c'.repeat(64);
const cacheDigest =
  '9f7d2f801be4f1c6bc6b9bea5c6a7a3ffe64e0b7ee69fab9a4a1b3a8cf4b5fc0';
const modelDigest =
  'be88613a50ba792bd5a2bc07b74bcd97c9ed9dbac028d27a44c6888e712323c3';
const branch = 'issue/138-build-a-mocked-agent-status-molecule';
const sessionId = 'inert-138-session';
const checkCommands = {
  'ui-molecules-discovery': [
    'pnpm',
    'exec',
    'nx',
    'show',
    'project',
    'ui-molecules',
    '--json',
  ],
  'ui-molecules-lint': ['pnpm', 'exec', 'nx', 'run', 'ui-molecules:lint'],
  'ui-molecules-test': [
    'pnpm',
    'exec',
    'node',
    'tools/policy/run-ui-molecules-tests.mjs',
    '--require-agent-status',
  ],
  'ui-molecules-build': ['pnpm', 'exec', 'nx', 'run', 'ui-molecules:build'],
};

function argv(operation, extra = []) {
  return [
    operation,
    '--issue',
    '138',
    '--pilot',
    '153',
    '--branch',
    branch,
    '--source-revision',
    revision,
    '--source-fingerprint',
    fingerprint,
    '--session-id',
    sessionId,
    '--model',
    'Qwen3.5-9B-Q5_K_S',
    '--independent-attempt',
    'issue-138-attempt-1',
    '--correction-attempt',
    'issue-138-attempt-2',
    ...(operation === 'authorize'
      ? ['--approval', 'maintainer-exact-153']
      : []),
    ...extra,
  ];
}

function evidence(kind = 'empty') {
  const claim = {
    state: 'active',
    worker: 'worker:peon',
    sessionId,
    branch,
    target: 'develop',
    worktreePath: path.resolve('disposable/issue-138'),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  return {
    host: { branch: 'develop', revision, trackedClean: true },
    issue: {
      number: 138,
      state: 'OPEN',
      labels: [
        'worker:peon',
        'status:in-progress',
        'hermes-profile:narrow-coding',
        'hermes-workflow:minimal-coding',
      ],
    },
    issueDigest,
    claim,
    revision,
    source: {
      clean: true,
      headRevision: revision,
      baseRevision: revision,
      fingerprint,
      workspacePath: '/home/peon/workspaces/issue-138',
    },
    windows: { clean: true, headRevision: revision },
    componentAbsent: true,
    model: { name: 'Qwen3.5-9B-Q5_K_S', healthy: true, digest: modelDigest },
    workerImage: trustedPeonWorkerImage,
    meterConfigured: true,
    cache: { lockDigest: cacheDigest },
    diskFreeBytes: 5 * 1024 ** 3,
    attemptsAbsent: true,
    checks: structuredClone(checkCommands),
    state:
      kind === 'authorized'
        ? {
            kind,
            authorization: {
              schema: 'stellar.single-use-peon-pilot/v1',
              issueNumber: 138,
              issueDigest,
              feedbackLevel: 'diagnostic',
              sessionId,
              branch,
              worktreePath: claim.worktreePath,
              sourceRevision: revision,
              sourceFingerprint: fingerprint,
              independentAttemptId: 'issue-138-attempt-1',
              correctionAttemptId: 'issue-138-attempt-2',
            },
          }
        : { kind },
  };
}

test('actual CLI without a fixed operation exits before any model request or state write', () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./run-issue-138-pilot.mjs', import.meta.url))],
    { encoding: 'utf8', timeout: 5000 },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Choose exactly one operation/);
  assert.equal(result.stdout, '');
});

test('read-only Podman image inspection accepts the existing rootless ID shape', () => {
  const id = 'a'.repeat(64);
  assert.equal(validatePinnedImageId(id), id);
  assert.equal(validatePinnedImageId(`sha256:${id}`), `sha256:${id}`);
  assert.throws(() => validatePinnedImageId('not-an-image-id'));
});

test('parser requires every exact identity and an explicit authorization approval token', () => {
  assert.equal(parsePilotArguments(argv('preflight')).operation, 'preflight');
  assert.throws(() => parsePilotArguments([]));
  assert.throws(() =>
    parsePilotArguments(argv('preflight', ['--unknown', 'x'])),
  );
  assert.throws(() =>
    parsePilotArguments(argv('preflight', ['--issue', '139'])),
  );
  assert.throws(() =>
    parsePilotArguments(
      argv('execute', ['--approval', 'maintainer-exact-153']),
    ),
  );
  assert.throws(() => parsePilotArguments(argv('authorize').slice(0, -2)));
  assert.throws(() =>
    parsePilotArguments(
      argv('authorize', ['--approval', 'maintainer-exact-153']),
    ),
  );
  assert.throws(() =>
    parsePilotArguments(['recover', ...argv('preflight').slice(1)]),
  );
});

test('read-only inert preflight reports exact identity and starts no worker or authorization', async () => {
  const observed = { authorize: 0, execute: 0, modelRequests: 0 };
  const result = await runPilotOperation(argv('preflight'), {
    inspect: async () => evidence(),
    issueAuthorization: async () => {
      observed.authorize += 1;
    },
    runPilot: async () => {
      observed.execute += 1;
    },
    signalSource: new EventEmitter(),
  });
  assert.equal(result.go, true);
  assert.equal(result.fingerprint, fingerprint);
  assert.equal(result.state, 'empty');
  assert.deepEqual(observed, { authorize: 0, execute: 0, modelRequests: 0 });
});

test('stale, dirty, missing or substituted preflight evidence fails before authorization', async () => {
  const cases = [
    (item) => {
      item.host.branch = 'issue/158';
    },
    (item) => {
      item.host.trackedClean = false;
    },
    (item) => {
      item.host.revision = 'c'.repeat(40);
    },
    (item) => {
      item.claim.sessionId = 'wrong';
    },
    (item) => {
      item.issueDigest = 'not-a-digest';
    },
    (item) => {
      item.claim.expiresAt = new Date(Date.now() - 1).toISOString();
    },
    (item) => {
      item.revision = 'c'.repeat(40);
    },
    (item) => {
      item.source.fingerprint = 'c'.repeat(64);
    },
    (item) => {
      item.windows.clean = false;
    },
    (item) => {
      item.source.clean = false;
    },
    (item) => {
      item.componentAbsent = false;
    },
    (item) => {
      item.model.healthy = false;
    },
    (item) => {
      item.model.name = 'wrong';
    },
    (item) => {
      item.meterConfigured = false;
    },
    (item) => {
      item.cache.lockDigest = 'c'.repeat(64);
    },
    (item) => {
      item.diskFreeBytes = 4 * 1024 ** 3 - 1;
    },
    (item) => {
      item.attemptsAbsent = false;
    },
    (item) => {
      item.checks['ui-molecules-test'] = ['untrusted'];
    },
    (item) => {
      item.state.kind = 'authorized';
    },
  ];
  for (const mutate of cases) {
    const item = evidence();
    mutate(item);
    let authorized = 0;
    await assert.rejects(
      runPilotOperation(argv('authorize'), {
        inspect: async () => item,
        issueAuthorization: async () => {
          authorized += 1;
        },
        signalSource: new EventEmitter(),
      }),
    );
    assert.equal(authorized, 0);
  }
});

test('explicit authorization calls the existing issuer once and refuses duplicate state', async () => {
  let calls = 0;
  const operations = {
    inspect: async () => evidence(),
    issueAuthorization: async ({ expectedIdentity, signal }) => {
      calls += 1;
      assert.equal(signal.aborted, false);
      assert.deepEqual(expectedIdentity, {
        issueNumber: 138,
        issueDigest,
        sessionId,
        branch,
        worktreePath: path.resolve('disposable/issue-138'),
        sourceRevision: revision,
        sourceFingerprint: fingerprint,
        independentAttemptId: 'issue-138-attempt-1',
        correctionAttemptId: 'issue-138-attempt-2',
      });
      return {
        schema: 'stellar.single-use-peon-pilot/v1',
        issueNumber: 138,
        issueDigest,
        feedbackLevel: 'diagnostic',
        id: 'inert-id',
        sessionId,
        branch,
        worktreePath: path.resolve('disposable/issue-138'),
        sourceRevision: revision,
        sourceFingerprint: fingerprint,
        independentAttemptId: 'issue-138-attempt-1',
        correctionAttemptId: 'issue-138-attempt-2',
      };
    },
    signalSource: new EventEmitter(),
  };
  const result = await runPilotOperation(argv('authorize'), operations);
  assert.equal(result.authorizationId, 'inert-id');
  assert.equal(calls, 1);
  operations.inspect = async () => evidence('authorized');
  await assert.rejects(runPilotOperation(argv('authorize'), operations));
  assert.equal(calls, 1);
});

test('signal after a durable authorization commit is reported as committed', async () => {
  const signals = new EventEmitter();
  const result = await runPilotOperation(argv('authorize'), {
    inspect: async () => evidence(),
    issueAuthorization: async () => {
      signals.emit('SIGINT');
      signals.emit('SIGTERM');
      return {
        schema: 'stellar.single-use-peon-pilot/v1',
        issueNumber: 138,
        issueDigest,
        feedbackLevel: 'diagnostic',
        id: 'committed-inert-id',
        sessionId,
        branch,
        worktreePath: path.resolve('disposable/issue-138'),
        sourceRevision: revision,
        sourceFingerprint: fingerprint,
        independentAttemptId: 'issue-138-attempt-1',
        correctionAttemptId: 'issue-138-attempt-2',
      };
    },
    signalSource: signals,
  });
  assert.equal(result.state, 'authorized');
  assert.equal(result.authorizationId, 'committed-inert-id');
  assert.equal(result.interruptedAfterCommit, true);
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});

test('execute accepts only exact issued authority, does not reauthorize, and cannot replay', async () => {
  let launches = 0;
  const operations = {
    inspect: async () => evidence('authorized'),
    issueAuthorization: async () => {
      throw new Error('authorize must remain separate');
    },
    runPilot: async () => {
      launches += 1;
      return { status: 'independent-peon-success' };
    },
    signalSource: new EventEmitter(),
  };
  const result = await runPilotOperation(argv('execute'), operations);
  assert.equal(result.result.status, 'independent-peon-success');
  assert.equal(launches, 1);
  operations.inspect = async () => evidence('consumed');
  await assert.rejects(runPilotOperation(argv('execute'), operations));
  assert.equal(launches, 1);
  const wrong = evidence('authorized');
  wrong.state.authorization.correctionAttemptId = 'issue-138-attempt-99';
  operations.inspect = async () => wrong;
  await assert.rejects(runPilotOperation(argv('execute'), operations));
  assert.equal(launches, 1);
});

test('SIGINT during delayed admission and repeated SIGTERM cannot launch later or succeed', async () => {
  const signals = new EventEmitter();
  let admissionStarted;
  const started = new Promise((resolve) => {
    admissionStarted = resolve;
  });
  let launches = 0;
  const pending = runPilotOperation(argv('execute'), {
    inspect: async () => evidence('authorized'),
    runPilot: async ({ signal }) => {
      admissionStarted();
      await new Promise((resolve) => setTimeout(resolve, 25));
      if (signal.aborted)
        throw new Error('Inert admission cancelled; no worker started.');
      launches += 1;
      return { status: 'independent-peon-success' };
    },
    signalSource: signals,
  });
  await started;
  signals.emit('SIGINT');
  signals.emit('SIGTERM');
  await assert.rejects(pending);
  assert.equal(launches, 0);
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});

test('worker, meter and uncertain termination failures retain failure without retry or recovery mode', async () => {
  for (const message of [
    'WorkerExit',
    'UsageAccountingFailure',
    'CancellationUnconfirmed',
  ]) {
    let runs = 0;
    const state = evidence('authorized');
    await assert.rejects(
      runPilotOperation(argv('execute'), {
        inspect: async () => state,
        runPilot: async () => {
          runs += 1;
          throw new Error(message);
        },
        signalSource: new EventEmitter(),
      }),
      new RegExp(message),
    );
    assert.equal(runs, 1);
    assert.equal(state.state.kind, 'authorized');
  }
  assert.throws(() =>
    parsePilotArguments(['recover', ...argv('execute').slice(1)]),
  );
});

test('pure evidence validation rejects an expired lease and an already consumed authorization', () => {
  const expected = parsePilotArguments(argv('execute'));
  const item = evidence('authorized');
  assert.equal(validatePilotEvidence(expected, item, 'execute').go, true);
  assert.throws(() =>
    validatePilotEvidence(
      expected,
      item,
      'execute',
      Date.parse(item.claim.expiresAt) + 1,
    ),
  );
  item.state.kind = 'consumed';
  assert.throws(() => validatePilotEvidence(expected, item, 'execute'));
});
