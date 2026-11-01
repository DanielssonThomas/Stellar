import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from './planning-evidence.mjs';
import { planEngineeringWork } from './planning.mjs';
import { readPlanningRecord, writePlanningRecord } from './planning-record.mjs';

const now = '2026-11-01T12:00:00.000Z';
const sha = 'a'.repeat(40);
const body = `## Objective
Add a visible loading state to the bounded profile atom.
## Context
The existing component has no loading indication.
## Expected outcome
Content is replaced by the shared skeleton while loading.
## Acceptance criteria
- [ ] The loading input renders the shared skeleton and restores content.
## Constraints
Only change the assigned atom and its focused test.
## Dependencies
None
## Verification expectations
Run focused component tests and affected lint.
`;

function fixture() {
  const task = {
    key: 'loading-state',
    milestone: 'UI foundation',
    after: [],
    issue: {
      title: 'Add profile loading state',
      body,
      labels: [
        'priority:low',
        'review:standard',
        'type:feature',
        'target:develop',
        'status:triage',
        'worker:peon',
      ],
    },
    assignment: {
      role: 'peon',
      rationale: 'Verified atom outcome matches the small bounded change.',
    },
  };
  const snapshot = {
    schemaVersion: 1,
    repository: 'DanielssonThomas/Stellar',
    revision: sha,
    policyRevision: sha,
    capturedAt: now,
    authorizedWorkers: ['peon'],
    targetBranches: ['develop'],
    issues: [{ number: 95, state: 'OPEN', type: 'type:epic' }],
    scopes: [
      {
        key: task.key,
        contractDigest: digest(task.issue),
        complexity: 'small',
        ambiguous: false,
        riskFloor: 'standard',
        requiredSkills: ['angular-atom'],
        files: [
          {
            filename: 'libs/ui/atoms/src/lib/atoms/profile-atom.component.ts',
            status: 'modified',
          },
        ],
        search: {
          query: 'profile loading skeleton',
          openComplete: true,
          recentClosedComplete: true,
          searchedAt: now,
          closedSince: '2026-10-01T00:00:00.000Z',
          resultNumbers: [],
          duplicateNumbers: [],
        },
      },
    ],
    evidence: [
      {
        id: 'attempt-1',
        worker: 'peon',
        skill: 'angular-atom',
        outcome: 'passed',
        revision: sha,
        artifact: 'trusted-attempts/attempt-1/verification.json',
        source: 'host-verified-attempt',
        completedAt: '2026-10-31T12:00:00.000Z',
      },
    ],
  };
  const packet = {
    schemaVersion: 1,
    planId: 'plan-98-1',
    repository: snapshot.repository,
    revision: sha,
    policyRevision: sha,
    snapshotDigest: digest(snapshot),
    epicNumber: 95,
    tasks: [task],
  };
  return { packet, snapshot };
}

function evaluate(value) {
  return planEngineeringWork(value.packet, value.snapshot, { now });
}

function rebind(value) {
  for (const task of value.packet.tasks) {
    const scope = value.snapshot.scopes.find((item) => item.key === task.key);
    if (scope) scope.contractDigest = digest(task.issue);
  }
  value.packet.snapshotDigest = digest(value.snapshot);
  return value;
}

test('prepares an evidenced bounded assignment without granting execution or mutating input', () => {
  const value = fixture();
  const original = structuredClone(value);
  const result = evaluate(value);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.recommendations[0].action, 'prepare');
  assert.deepEqual(result.recommendations[0].capability.evidenceIds, [
    'attempt-1',
  ]);
  assert.deepEqual(value, original);
  assert.equal(result.packetDigest, digest(value.packet));
  value.packet.tasks[0].after.push('later-input-mutation');
  assert.deepEqual(result.recommendations[0].after, []);
});

test('rejects changed repository, revision, policy and snapshot evidence', () => {
  for (const mutate of [
    (v) => {
      v.packet.revision = 'b'.repeat(40);
    },
    (v) => {
      v.packet.policyRevision = 'b'.repeat(40);
    },
    (v) => {
      v.packet.repository = 'other/repository';
    },
    (v) => {
      v.snapshot.evidence = [];
    },
    (v) => {
      v.packet.tasks[0].issue.body += '\nChanged scope';
    },
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(() => evaluate(value), /stale|scope assessment/);
  }
  assert.throws(
    () =>
      planEngineeringWork(fixture().packet, fixture().snapshot, {
        now: '2026-11-01T13:00:00.000Z',
      }),
    /stale/,
  );
});

test('requires complete fresh open and recent-closed search and resolves duplicates to reuse', () => {
  for (const field of ['openComplete', 'recentClosedComplete']) {
    const value = fixture();
    value.snapshot.scopes[0].search[field] = false;
    assert.throws(() => evaluate(rebind(value)), /complete/);
  }
  const value = fixture();
  value.snapshot.issues.push({
    number: 70,
    state: 'CLOSED',
    status: 'status:done',
  });
  Object.assign(value.snapshot.scopes[0].search, {
    resultNumbers: [70],
    duplicateNumbers: [70],
  });
  value.packet.tasks[0].assignment.role = 'architect';
  const result = evaluate(rebind(value)).recommendations[0];
  assert.equal(result.action, 'reuse');
  assert.deepEqual(result.duplicates, [70]);
  value.snapshot.scopes[0].search.closedSince = now;
  assert.throws(() => evaluate(rebind(value)), /window/);
});

test('reuses issue policy for sections, owner identity, review metadata and allowed targets', () => {
  for (const mutate of [
    (task) => {
      task.issue.body = task.issue.body.replace('## Constraints', '## Other');
    },
    (task) => {
      task.issue.labels = task.issue.labels.filter(
        (x) => x !== 'review:standard',
      );
    },
    (task) => {
      task.issue.labels = task.issue.labels.map((x) =>
        x === 'worker:peon' ? 'worker:unknown' : x,
      );
    },
    (task) => {
      task.issue.labels = task.issue.labels.map((x) =>
        x === 'target:develop' ? 'target:release/2026.11' : x,
      );
    },
    (task) => {
      task.issue.body = task.issue.body.replace('## Context', '## Other');
    },
    (task) => {
      task.issue.body = task.issue.body.replace(
        'The existing component has no loading indication.',
        '',
      );
    },
  ]) {
    const value = fixture();
    mutate(value.packet.tasks[0]);
    assert.throws(() => evaluate(rebind(value)));
  }
  const value = fixture();
  value.packet.tasks[0].issue.labels = value.packet.tasks[0].issue.labels.map(
    (x) => (x === 'priority:low' ? 'priority:critical' : x),
  );
  assert.throws(() => evaluate(rebind(value)), /critical priority/);
});

test('escalates sensitive scope, rename source, ambiguity and unsupported complexity', () => {
  for (const mutate of [
    (scope) => {
      scope.files = [
        { filename: 'tools/policy/access.mjs', status: 'modified' },
      ];
    },
    (scope) => {
      scope.files = [
        {
          filename: 'ordinary.md',
          previous_filename: 'AGENTS.md',
          status: 'renamed',
        },
      ];
    },
    (scope) => {
      scope.riskFloor = 'critical';
    },
  ]) {
    const value = fixture();
    mutate(value.snapshot.scopes[0]);
    assert.throws(() => evaluate(rebind(value)), /below trusted/);
    value.packet.tasks[0].issue.labels = value.packet.tasks[0].issue.labels.map(
      (x) => (x === 'review:standard' ? 'review:critical' : x),
    );
    value.packet.tasks[0].assignment.role = 'foreman';
    assert.equal(evaluate(rebind(value)).recommendations[0].action, 'escalate');
  }
  for (const [field, setting, role] of [
    ['ambiguous', true, 'architect'],
    ['complexity', 'large', 'foreman'],
  ]) {
    const value = fixture();
    value.snapshot.scopes[0][field] = setting;
    value.packet.tasks[0].assignment.role = role;
    assert.equal(evaluate(rebind(value)).recommendations[0].action, 'escalate');
  }
});

test('capability decisions include failure history and cannot be raised by self-reported confidence', () => {
  const value = fixture();
  value.snapshot.evidence.push({
    ...value.snapshot.evidence[0],
    id: 'failed-2',
    outcome: 'failed',
    completedAt: '2026-11-01T11:00:00.000Z',
  });
  value.packet.tasks[0].assignment.confidence = 1;
  assert.throws(() => evaluate(rebind(value)), /evidence-based role/);
  value.packet.tasks[0].assignment.role = 'foreman';
  let result = evaluate(rebind(value)).recommendations[0];
  assert.deepEqual(result.capability.failureIds, ['failed-2']);
  assert.equal(result.reason, 'insufficient-capability-evidence');
  value.snapshot.evidence.push({
    ...value.snapshot.evidence[0],
    id: 'recovered-3',
    completedAt: '2026-11-01T11:30:00.000Z',
  });
  value.packet.tasks[0].assignment.role = 'peon';
  result = evaluate(rebind(value)).recommendations[0];
  assert.equal(result.action, 'prepare');
  assert.deepEqual(result.capability.failureIds, ['failed-2']);
  value.snapshot.evidence[0].source = 'model-confidence';
  assert.throws(() => evaluate(rebind(value)), /host-verified/);
});

test('missing skill or authorization evidence escalates rather than recommending a worker', () => {
  for (const mutate of [
    (v) => {
      v.snapshot.evidence = [];
    },
    (v) => {
      v.snapshot.scopes[0].requiredSkills.push('native-audio');
    },
  ]) {
    const value = fixture();
    mutate(value);
    value.packet.tasks[0].assignment.role = 'foreman';
    assert.equal(evaluate(rebind(value)).recommendations[0].action, 'escalate');
  }
  const value = fixture();
  value.snapshot.authorizedWorkers = [];
  assert.throws(() => evaluate(rebind(value)), /not authorized/);
});

test('checks native dependency equality and queues unresolved issue blockers', () => {
  const value = fixture();
  const task = value.packet.tasks[0];
  task.issue.number = 138;
  task.issue.body = task.issue.body.replace('None', '#96');
  value.snapshot.issues.push(
    {
      number: 138,
      state: 'OPEN',
      contractDigest: digest(task.issue),
      dependencies: [96],
    },
    { number: 96, state: 'OPEN', status: 'status:in-progress' },
  );
  assert.equal(evaluate(rebind(value)).recommendations[0].action, 'queue');
  value.snapshot.issues.find((i) => i.number === 138).dependencies = [];
  assert.throws(() => evaluate(rebind(value)), /native dependencies/);
});

test('existing active work and ownership changes require Architect reconciliation', () => {
  const value = fixture();
  const task = value.packet.tasks[0];
  task.issue.number = 138;
  task.issue.labels = task.issue.labels.map((label) =>
    label === 'status:triage' ? 'status:in-progress' : label,
  );
  value.snapshot.issues.push({
    number: 138,
    state: 'OPEN',
    contractDigest: digest(task.issue),
    dependencies: [],
  });
  task.assignment.role = 'architect';
  assert.equal(
    evaluate(rebind(value)).recommendations[0].reason,
    'existing-work-needs-reconciliation',
  );
  const owned = fixture();
  owned.packet.tasks[0].issue.labels = owned.packet.tasks[0].issue.labels.map(
    (label) => (label === 'worker:peon' ? 'owner:codex' : label),
  );
  owned.packet.tasks[0].assignment.role = 'architect';
  assert.equal(
    evaluate(rebind(owned)).recommendations[0].reason,
    'ownership-review-required',
  );
});

test('duplicate contracts and existing identities cannot create parallel assignments', () => {
  const value = fixture();
  value.packet.tasks.push({
    ...structuredClone(value.packet.tasks[0]),
    key: 'duplicate',
  });
  assert.throws(() => evaluate(value), /Task contracts/);
});

test('tied failure evidence and future evidence cannot imply capability recovery', () => {
  const value = fixture();
  value.snapshot.evidence.push({
    ...value.snapshot.evidence[0],
    id: 'failure',
    outcome: 'failed',
  });
  value.packet.tasks[0].assignment.role = 'foreman';
  assert.equal(
    evaluate(rebind(value)).recommendations[0].capability.eligible,
    false,
  );
  value.snapshot.evidence[1].completedAt = '2026-11-02T00:00:00.000Z';
  assert.throws(() => evaluate(rebind(value)), /host-verified/);
});

test('orders milestones topologically, queues planned dependencies and rejects cycles', () => {
  const value = fixture();
  const second = structuredClone(value.packet.tasks[0]);
  second.key = 'second';
  second.issue.title = 'Add second profile behavior';
  second.after = ['loading-state'];
  value.packet.tasks.unshift(second);
  value.snapshot.scopes.push({
    ...structuredClone(value.snapshot.scopes[0]),
    key: 'second',
  });
  const result = evaluate(rebind(value));
  assert.deepEqual(
    result.recommendations.map((r) => r.key),
    ['loading-state', 'second'],
  );
  assert.equal(result.recommendations[1].action, 'queue');
  value.packet.tasks[1].after = ['second'];
  assert.throws(() => evaluate(rebind(value)), /cycle/);
});

test('stores exclusive revision-bound records and rejects corruption and stale reads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stellar-planning-'));
  try {
    const path = join(directory, 'plan.json');
    const value = fixture();
    const result = evaluate(value);
    await writePlanningRecord(path, value.packet, value.snapshot, { now });
    const expected = {
      snapshotDigest: result.snapshotDigest,
      packetDigest: result.packetDigest,
    };
    assert.deepEqual(await readPlanningRecord(path, expected), result);
    await assert.rejects(
      writePlanningRecord(path, value.packet, value.snapshot, { now }),
      /EEXIST/,
    );
    await assert.rejects(
      readPlanningRecord(path, { ...expected, snapshotDigest: '0'.repeat(64) }),
      /expected snapshot/,
    );
    const stored = JSON.parse(await readFile(path, 'utf8'));
    stored.record.executionAuthorized = true;
    await writeFile(path, JSON.stringify(stored));
    await assert.rejects(readPlanningRecord(path, expected), /integrity/);
    await writeFile(path, '{');
    await assert.rejects(readPlanningRecord(path, expected), SyntaxError);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
