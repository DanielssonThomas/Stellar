import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  issueSingleUsePilotAuthorization,
  recoverSingleUsePeonPilot,
  runSingleUsePeonPilot,
} from './single-use-peon-pilot.mjs';
import { readHandoff } from './supervise-worker.mjs';

const revision = 'a'.repeat(40);
const sourceDigest = 'b'.repeat(64);
const copyDigest = 'c'.repeat(64);
const candidateDigest = 'd'.repeat(64);
const sessionId = 'inert-138-session';
const issue = {
  number: 138,
  state: 'OPEN',
  title: 'Build a mocked agent-status molecule',
  body: [
    '## Objective',
    'Create a mocked agent status molecule.',
    '## Expected outcome',
    'One reusable component.',
    '## Acceptance criteria',
    '- [ ] Generate and test the component.',
    '## Constraints',
    'Only edit the molecule source.',
    '## Dependencies',
    'None',
    '## Verification expectations',
    'Run lint, test, and build.',
  ].join('\n'),
  labels: [
    'priority:low',
    'target:develop',
    'type:feature',
    'status:in-progress',
    'worker:peon',
    'review:standard',
    'hermes-profile:narrow-coding',
    'hermes-workflow:minimal-coding',
  ],
  dependencies: [],
};

async function fixture(mode = 'success') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stellar-pilot-156-'));
  const repositoryRoot = path.join(root, 'repo');
  await mkdir(repositoryRoot);
  const branch = 'issue/138-agent-status';
  const claim = {
    state: 'active',
    worker: 'worker:peon',
    sessionId,
    target: 'develop',
    branch,
    worktreePath: process.cwd(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  };
  const source = {
    clean: true,
    headRevision: revision,
    baseRevision: revision,
    fingerprint: sourceDigest,
    workspacePath: '/home/peon/workspaces/issue-138',
    changes: [],
  };
  const observed = { workers: 0, copies: 0, checks: 0, limits: [] };
  const options = { repositoryRoot, sessionId };
  const adapters = {
    loadIssue: async () => issue,
    inspectClaim: async () => claim,
    resolveDevelopHead: async () => revision,
    inspectWorkspace: async () => source,
    getProtectedPaths: () => ['AGENTS.md'],
    runCommand(args) {
      if (args[0] === 'id') return '1000';
      if (args[0] === 'df') return 'Avail\n5368709120';
      if (args[0] === 'du') return `1024\t${args.at(-1)}`;
      if (args[0] === 'realpath') return args.at(-1);
      if (args[0] === 'stat') return '1000:700';
      if (['mkdir', 'cp', 'rm'].includes(args[0])) return '';
      throw new Error(`Unexpected inert command ${args[0]}`);
    },
    prepareSource({ attemptId }) {
      observed.copies += 1;
      return {
        schema: 'stellar.private-source/v1',
        attemptId,
        sourceRevision: revision,
        sourceFingerprint: sourceDigest,
        contentDigest: copyDigest,
        privatePath: `/home/peon/stellar-private-pilot-source/${attemptId}/workspace`,
        files: [],
      };
    },
    prepareDependencies({ attemptNumber }) {
      return {
        dependencyRoot: `/home/peon/stellar-private-pilot-deps/issue-138-attempt-${attemptNumber}/workspace`,
      };
    },
    readWorkspaceFile(_issueNumber, name) {
      return readFileSync(path.join(process.cwd(), name), 'utf8');
    },
    createWorkerAdapter({ privatePilot }) {
      observed.limits.push(privatePilot.limits);
      const usage = {
        toolCalls: 3,
        modelTokens: 1_000,
        forwardedRequests: 1,
        requestRecords: [],
        exceededResource: null,
      };
      return {
        id: 'peon',
        async usage() {
          return usage;
        },
        async run() {
          observed.workers += 1;
          const attemptId = `issue-138-attempt-${privatePilot.attemptNumber}`;
          const outcome =
            mode === 'failed-first' && privatePilot.attemptNumber === 1
              ? 'failed'
              : 'completed';
          if (mode === 'meter-failure')
            throw new Error('Trusted meter unavailable.');
          return {
            status: outcome,
            usage,
            ...(outcome === 'failed'
              ? {
                  failure: {
                    code: 'WorkerExit',
                    message: 'Real stopped task failure in inert test.',
                  },
                }
              : {}),
            ...(mode === 'simulation'
              ? {}
              : {
                  pilotEvidence: {
                    schema: 'stellar.metered-private-peon/v1',
                    attemptId:
                      mode === 'wrong-attempt'
                        ? 'issue-138-attempt-99'
                        : attemptId,
                    sourceDigest: copyDigest,
                    workerState:
                      mode === 'uncertain-termination' ? 'running' : 'absent',
                    meterState: 'absent',
                  },
                }),
          };
        },
        async cancel() {
          return true;
        },
      };
    },
    assertTrustedResult(result, attemptId, digest) {
      if (
        mode === 'simulation' ||
        result.pilotEvidence?.attemptId !== attemptId ||
        result.pilotEvidence?.sourceDigest !== digest ||
        result.pilotEvidence?.workerState !== 'absent'
      )
        throw new Error('Inert or wrong-attempt output is not trusted.');
    },
    async collect({ attemptNumber }) {
      return {
        attemptId:
          mode === 'wrong-output'
            ? 'issue-138-attempt-99'
            : `issue-138-attempt-${attemptNumber}`,
        sourceRevision: revision,
        sourceFingerprint: sourceDigest,
        baselineDigest: copyDigest,
        contentDigest: candidateDigest,
        changes: [
          'libs/ui/molecules/src/lib/agent-status-molecule.component.ts',
        ],
      };
    },
    async runChecks() {
      observed.checks += 1;
      return {
        status: mode === 'failed-checks' ? 'tests-failed' : 'tests-passed',
        integrity: 'verified',
        candidateDigest,
        checks: [
          'ui-molecules-discovery',
          'ui-molecules-lint',
          'ui-molecules-test',
          'ui-molecules-build',
        ].map((name) => ({
          name,
          exitCode:
            mode === 'failed-checks' && name === 'ui-molecules-test' ? 1 : 0,
        })),
      };
    },
  };
  return {
    root,
    options,
    adapters,
    claim,
    source,
    observed,
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('one independent metered success ends without feedback or correction', async () => {
  const f = await fixture();
  try {
    await issueSingleUsePilotAuthorization(f.options, f.adapters);
    const result = await runSingleUsePeonPilot(f.options, f.adapters);
    assert.equal(result.status, 'independent-peon-success');
    assert.equal(result.independent.candidateDigest, candidateDigest);
    assert.equal(result.correction, null);
    assert.equal(f.observed.workers, 1);
    assert.equal(f.observed.copies, 1);
    assert.equal(f.observed.checks, 1);
    assert.deepEqual(f.source.changes, []);
    await assert.rejects(
      runSingleUsePeonPilot(f.options, f.adapters),
      /already consumed/,
    );
  } finally {
    await f.cleanup();
  }
});

test('a stopped recorded failure permits one feedback event and one correction', async () => {
  const f = await fixture('failed-first');
  try {
    await issueSingleUsePilotAuthorization(f.options, f.adapters);
    const result = await runSingleUsePeonPilot(f.options, f.adapters);
    assert.equal(result.status, 'assisted-peon-success');
    assert.equal(f.observed.workers, 2);
    assert.equal(f.observed.copies, 2);
    assert.equal(f.observed.limits.length, 2);
    assert.equal(f.observed.limits[0].maxModelTokensPerWorker, 32_000);
    assert.equal(f.observed.limits[1].maxModelTokensPerWorker, 31_000);
    assert.equal(f.observed.limits[1].maxToolCallsPerWorker, 61);
    assert.ok(f.observed.limits[1].maxRuntimeMsPerWorker < 600_000);
    const stateRoot = path.join(
      f.root,
      '.stellar-supervisor-state',
      'single-use-pilot-138',
    );
    const handoff = await readHandoff(
      path.join(stateRoot, 'independent-handoff.json'),
    );
    assert.equal(handoff.mentorFeedback.length, 1);
    assert.equal(handoff.mentorFeedback[0].evidence.kind, 'failure');
    assert.equal(result.mentorContribution.level, 'diagnostic');
  } finally {
    await f.cleanup();
  }
});

test('simulated success and metering failure leave consumed authorization quarantined', async () => {
  for (const mode of ['simulation', 'meter-failure']) {
    const f = await fixture(mode);
    try {
      await issueSingleUsePilotAuthorization(f.options, f.adapters);
      await assert.rejects(runSingleUsePeonPilot(f.options, f.adapters));
      assert.equal(f.observed.workers, 1);
      const stateRoot = path.join(
        f.root,
        '.stellar-supervisor-state',
        'single-use-pilot-138',
      );
      assert.equal(
        JSON.parse(await readFile(path.join(stateRoot, 'active.json'))).status,
        'consuming',
      );
      await assert.rejects(
        runSingleUsePeonPilot(f.options, f.adapters),
        /already consumed/,
      );
    } finally {
      await f.cleanup();
    }
  }
});

test('stale claim and changed source fail before authorization consumption', async () => {
  for (const change of ['claim', 'source']) {
    const f = await fixture();
    try {
      await issueSingleUsePilotAuthorization(f.options, f.adapters);
      if (change === 'claim') f.claim.sessionId = 'replaced-session';
      else f.source.fingerprint = 'e'.repeat(64);
      await assert.rejects(runSingleUsePeonPilot(f.options, f.adapters));
      const stateRoot = path.join(
        f.root,
        '.stellar-supervisor-state',
        'single-use-pilot-138',
      );
      assert.equal(
        JSON.parse(await readFile(path.join(stateRoot, 'authorized.json')))
          .issueNumber,
        138,
      );
      assert.equal(f.observed.workers, 0);
    } finally {
      await f.cleanup();
    }
  }
});

test('recovery requires supervisor and exact worker, meter, verifier termination', async () => {
  const f = await fixture('simulation');
  try {
    await issueSingleUsePilotAuthorization(f.options, f.adapters);
    await assert.rejects(runSingleUsePeonPilot(f.options, f.adapters));
    await assert.rejects(
      recoverSingleUsePeonPilot({
        repositoryRoot: f.options.repositoryRoot,
        confirmSupervisorStopped: async () => false,
      }),
      /uncertain/,
    );
    await assert.rejects(
      recoverSingleUsePeonPilot({
        repositoryRoot: f.options.repositoryRoot,
        confirmSupervisorStopped: async () => true,
        confirmTermination: async () => ({ confirmed: false }),
      }),
      /uncertain/,
    );
    const recovered = await recoverSingleUsePeonPilot({
      repositoryRoot: f.options.repositoryRoot,
      confirmSupervisorStopped: async () => true,
      confirmTermination: async () => ({ confirmed: true, state: 'absent' }),
    });
    assert.equal(recovered.authorizationConsumed, true);
    await assert.rejects(
      runSingleUsePeonPilot(f.options, f.adapters),
      /already consumed/,
    );
  } finally {
    await f.cleanup();
  }
});

test('duplicate issuance, wrong attempt, and uncertain termination fail closed', async () => {
  for (const mode of ['wrong-attempt', 'uncertain-termination']) {
    const f = await fixture(mode);
    try {
      await issueSingleUsePilotAuthorization(f.options, f.adapters);
      await assert.rejects(
        issueSingleUsePilotAuthorization(f.options, f.adapters),
        /EEXIST/,
      );
      await assert.rejects(runSingleUsePeonPilot(f.options, f.adapters));
      assert.equal(f.observed.workers, 1);
      await assert.rejects(
        runSingleUsePeonPilot(f.options, f.adapters),
        /already consumed/,
      );
    } finally {
      await f.cleanup();
    }
  }
});

test('changed source during preparation stops before worker launch', async () => {
  const f = await fixture();
  try {
    const prepare = f.adapters.prepareSource;
    f.adapters.prepareSource = (options) => {
      const result = prepare(options);
      f.source.fingerprint = 'e'.repeat(64);
      return result;
    };
    await issueSingleUsePilotAuthorization(f.options, f.adapters);
    await assert.rejects(
      runSingleUsePeonPilot(f.options, f.adapters),
      /stale or substituted/,
    );
    assert.equal(f.observed.workers, 0);
  } finally {
    await f.cleanup();
  }
});

test('wrong-attempt output is rejected and failing repository tests cannot report success', async () => {
  for (const mode of ['wrong-output', 'failed-checks']) {
    const f = await fixture(mode);
    try {
      await issueSingleUsePilotAuthorization(f.options, f.adapters);
      if (mode === 'wrong-output') {
        await assert.rejects(
          runSingleUsePeonPilot(f.options, f.adapters),
          /not eligible|another attempt/,
        );
      } else {
        const result = await runSingleUsePeonPilot(f.options, f.adapters);
        assert.equal(result.status, 'peon-correction-failed');
        assert.equal(result.independent.repositoryChecks, 'tests-failed');
        assert.equal(result.correction.repositoryChecks, 'tests-failed');
        assert.equal(f.observed.workers, 2);
      }
    } finally {
      await f.cleanup();
    }
  }
});

test('invalid feedback, cancellation, timeout, and disk exhaustion never retry', async () => {
  for (const mode of ['feedback', 'cancel', 'timeout', 'disk']) {
    const f = await fixture('failed-first');
    try {
      await issueSingleUsePilotAuthorization(f.options, f.adapters);
      if (mode === 'feedback')
        f.adapters.appendFeedback = async () => {
          throw new Error('Stale feedback evidence.');
        };
      if (mode === 'cancel') {
        const controller = new AbortController();
        controller.abort();
        f.options.signal = controller.signal;
      }
      if (mode === 'timeout')
        f.adapters.runSupervisor = async () => ({
          status: 'paused',
          handoff: { safeToResume: false, workerUsage: { peon: {} } },
        });
      if (mode === 'disk') {
        const run = f.adapters.runCommand;
        f.adapters.runCommand = (args) =>
          args[0] === 'df' ? 'Avail\n100' : run(args);
      }
      await assert.rejects(runSingleUsePeonPilot(f.options, f.adapters));
      assert.equal(f.observed.workers <= 1, true);
      if (mode !== 'cancel')
        await assert.rejects(
          runSingleUsePeonPilot(f.options, f.adapters),
          /already consumed/,
        );
    } finally {
      await f.cleanup();
    }
  }
});
