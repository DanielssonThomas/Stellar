import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertAuthorizedTwoStageIssue,
  assertStageVerificationAllowed,
  authorizeImplementationStage,
  validateImplementationStage,
  validateInspectionStage,
} from './two-stage-peon-workflow.mjs';

const identity = {
  id: 'attempt-container-id',
  startedAt: '2026-10-23T00:00:00Z',
  restartCount: 0,
};
const guidanceDigest = 'a'.repeat(64);
const selectedIssue = {
  number: 50,
  state: 'OPEN',
  labels: [
    'worker:peon',
    'priority:low',
    'target:develop',
    'hermes-profile:narrow-coding',
    'hermes-workflow:two-stage',
    'status:in-progress',
  ],
  dependencies: [],
};
const requestRecord = (request, stage) => ({
  request,
  stage,
  decision: 'forwarded',
});
const usage = (stage, requests) => ({
  stage,
  forwardedRequests: requests,
  inflightRequests: 0,
  modelTokens: 1200,
  toolCalls: 3,
  exceededResource: null,
  requestRecords: Array.from({ length: requests }, (_, index) =>
    requestRecord(index + 1, index === 0 ? 'inspect' : 'implement'),
  ),
});
const handoff = (overrides = {}) =>
  JSON.stringify({
    version: 1,
    issueNumber: 50,
    guidanceDigest,
    summary: 'The assigned atom needs the authorized avatar variant.',
    sourceEvidence: [
      {
        path: 'libs/ui/atoms/skeleton-atom.ts',
        excerpt: 'export class SkeletonAtom',
      },
    ],
    ...overrides,
  });

function validInspection(overrides = {}) {
  return validateInspectionStage({
    issue: selectedIssue,
    issueNumber: 50,
    exitCode: 0,
    workerCleanup: { confirmed: true, state: 'absent' },
    snapshotCleanup: { confirmed: true },
    meterIdentityBefore: identity,
    meterIdentityAfter: identity,
    usage: usage('inspect', 1),
    initialWorkspaceFingerprint: 'clean-before',
    finalWorkspaceFingerprint: 'clean-before',
    workspaceAccess: 'read-only',
    githubCredentialAvailable: false,
    workspaceContainsGitMetadata: false,
    handoff: handoff(),
    guidanceDigest,
    allowedEvidencePaths: ['libs/ui/atoms/skeleton-atom.ts'],
    verifyExcerpt: (path, excerpt) =>
      path === 'libs/ui/atoms/skeleton-atom.ts' &&
      excerpt === 'export class SkeletonAtom',
    ...overrides,
  });
}

test('inspection stage accepts only completed, read-only, bounded trusted evidence', () => {
  const result = validInspection();
  assert.equal(result.issueNumber, 50);
  assert.equal(result.handoff.sourceEvidence.length, 1);
  for (const boundary of [
    { workspaceAccess: 'read-write' },
    { githubCredentialAvailable: true },
    { workspaceContainsGitMetadata: true },
  ])
    assert.throws(() => validInspection(boundary), /boundary is not enforced/);
});

test('two-stage selection requires fresh exact owner, priority, target, profile, status, and completed dependencies', () => {
  assert.equal(assertAuthorizedTwoStageIssue(selectedIssue), selectedIssue);
  for (const issue of [
    { ...selectedIssue, state: 'CLOSED' },
    {
      ...selectedIssue,
      labels: selectedIssue.labels.filter((label) => label !== 'priority:low'),
    },
    {
      ...selectedIssue,
      labels: [...selectedIssue.labels, 'target:main'],
    },
    {
      ...selectedIssue,
      dependencies: [{ state: 'OPEN', status: 'status:in-progress' }],
    },
  ])
    assert.throws(
      () => assertAuthorizedTwoStageIssue(issue),
      /does not authorize the two-stage workflow/,
    );
});

test('inspection stage fails closed on incomplete or unsafe lifecycle evidence', () => {
  for (const override of [
    { exitCode: 1 },
    { workerCleanup: { confirmed: false } },
    { snapshotCleanup: { confirmed: false } },
    { meterIdentityAfter: { ...identity, restartCount: 1 } },
    { finalWorkspaceFingerprint: 'workspace-was-modified' },
    { usage: { ...usage('inspect', 1), exceededResource: 'model-requests' } },
    { usage: { ...usage('inspect', 1), forwardedRequests: 2 } },
  ]) {
    assert.throws(
      () => validInspection(override),
      (error) => {
        if (
          override.workerCleanup?.confirmed === false ||
          override.snapshotCleanup?.confirmed === false
        )
          assert.equal(error.safeToResume, false);
        if (override.meterIdentityAfter)
          assert.equal(error.safeToResume, false);
        if (override.finalWorkspaceFingerprint)
          assert.equal(error.safeToResume, false);
        return true;
      },
    );
  }
});

test('inspection handoff rejects wrong issue, oversized content, and unverified excerpts', () => {
  assert.throws(
    () => validInspection({ handoff: handoff({ issueNumber: 51 }) }),
    /trusted issue context/,
  );
  assert.throws(
    () => validInspection({ handoff: 'x'.repeat(12 * 1024 + 1) }),
    /size limit/,
  );
  assert.throws(
    () =>
      validInspection({
        verifyExcerpt: () => false,
      }),
    /did not match trusted files/,
  );
});

test('trusted transition preserves the same sidecar identity and monotonic counters', async () => {
  const inspection = validInspection();
  const currentIdentity = identity;
  let currentUsage = usage('inspect', 1);
  let transitions = 0;
  const transition = await authorizeImplementationStage({
    inspection,
    readMeterIdentity: async () => currentIdentity,
    readUsage: async () => currentUsage,
    advanceMeter: async () => {
      transitions += 1;
      currentUsage = { ...currentUsage, stage: 'implement' };
      return { stage: 'implement' };
    },
  });
  assert.equal(transitions, 1);
  assert.equal(transition.stage, 'implement');
  assert.equal(transition.usage.forwardedRequests, 1);
});

test('transition refuses reset, drift, extra request, and repeated stage advance', async () => {
  const inspection = validInspection();
  const changedIdentity = { ...identity, restartCount: 1 };
  await assert.rejects(
    authorizeImplementationStage({
      inspection,
      readMeterIdentity: async () => changedIdentity,
      readUsage: async () => usage('inspect', 1),
      advanceMeter: async () => ({ stage: 'implement' }),
    }),
    (error) => error.safeToResume === false,
  );
  await assert.rejects(
    authorizeImplementationStage({
      inspection,
      readMeterIdentity: async () => identity,
      readUsage: async () => usage('inspect', 2),
      advanceMeter: async () => ({ stage: 'implement' }),
    }),
    /changed before the stage transition/,
  );
  await assert.rejects(
    authorizeImplementationStage({
      inspection,
      readMeterIdentity: async () => identity,
      readUsage: async () => usage('inspect', 1),
      advanceMeter: async () => ({ stage: 'inspect' }),
    }),
    /did not confirm/,
  );
});

test('cancellation during transition prevents implementation launch', async () => {
  const inspection = validInspection();
  let advanced = false;
  await assert.rejects(
    authorizeImplementationStage({
      inspection,
      readMeterIdentity: async () => identity,
      readUsage: async () => usage('inspect', 1),
      advanceMeter: async () => {
        advanced = true;
        return { stage: 'implement' };
      },
      isCancelled: () => true,
    }),
    (error) => error.safeToResume === false,
  );
  assert.equal(advanced, false);
});

test('implementation stage rejects finalizer denials, unsafe cleanup, or no code changes', async () => {
  const inspection = validInspection();
  const transition = {
    stage: 'implement',
    issueNumber: 50,
    meterIdentity: identity,
  };
  const base = {
    transition,
    exitCode: 0,
    workerCleanup: { confirmed: true, state: 'absent' },
    meterIdentity: identity,
    usage: usage('implement', 2),
    changedPaths: ['libs/ui/atoms/skeleton-atom.ts'],
  };
  assert.throws(
    () => assertStageVerificationAllowed(base),
    /requires a completed implementation stage/,
  );
  const accepted = validateImplementationStage(base);
  assert.equal(assertStageVerificationAllowed(accepted), true);
  assert.throws(
    () =>
      validateImplementationStage({
        ...base,
        usage: {
          ...usage('implement', 2),
          exceededResource: 'model-requests',
          requestRecords: [
            requestRecord(1, 'inspect'),
            requestRecord(2, 'implement'),
            {
              request: 3,
              stage: 'implement',
              decision: 'denied-request-limit',
            },
          ],
        },
      }),
    /usage evidence/,
  );
  assert.throws(
    () => validateImplementationStage({ ...base, changedPaths: [] }),
    /No trusted source-change evidence/,
  );
  assert.throws(
    () =>
      validateImplementationStage({
        ...base,
        workerCleanup: { confirmed: false },
      }),
    (error) => error.safeToResume === false,
  );
  assert.equal(inspection.issueNumber, 50);
});
