import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  appendProgress,
  changeStatus,
  validateFreshIssue,
  validateStatusTransition,
} from './update-issue.mjs';

const acceptance = `## Objective
Do the work.

## Expected outcome
The result is observable.

## Acceptance criteria
- [ ] The result can be verified.

## Constraints
Keep the change scoped.

## Dependencies
None

## Verification expectations
Run relevant checks.`;

function issue(status = 'status:in-progress', overrides = {}) {
  return {
    number: 42,
    body: acceptance,
    state: 'OPEN',
    labels: [
      'priority:medium',
      'target:develop',
      'type:feature',
      status,
      'owner:codex',
    ],
    dependencies: [],
    ...overrides,
  };
}

const blockerReport = `## Blocker
The execution environment is unavailable.

## Evidence
The required local command could not start.

## Attempts
Checked runtime installation and retried once.

## Progress
The issue remains safely in its worktree.`;

describe('issue progress metadata', () => {
  it('accepts a fresh issue owned by the worker with matching dependencies', () => {
    assert.deepEqual(validateFreshIssue(issue(), 'codex'), {
      valid: true,
      errors: [],
    });
  });

  it('rejects a different owner, invalid labels, and mismatched dependencies', () => {
    assert.equal(validateFreshIssue(issue(), 'maintainer').valid, false);
    assert.equal(
      validateFreshIssue(
        issue('status:in-progress', {
          labels: [
            'priority:medium',
            'priority:high',
            'target:develop',
            'type:feature',
            'status:in-progress',
            'owner:codex',
          ],
        }),
        'codex',
      ).valid,
      false,
    );
    const mismatch = issue('status:in-progress', {
      body: acceptance.replace('Dependencies\nNone', 'Dependencies\n#41'),
    });
    assert.ok(
      validateFreshIssue(mismatch, 'codex').errors.some((error) =>
        error.includes('do not match'),
      ),
    );
  });

  it('allows only the current status transition for the current owner', () => {
    assert.equal(
      validateStatusTransition({
        issue: issue(),
        worker: 'codex',
        expected: 'status:in-progress',
        next: 'status:blocked',
        comment: blockerReport,
      }).valid,
      true,
    );
    assert.equal(
      validateStatusTransition({
        issue: issue(),
        worker: 'codex',
        expected: 'status:ready',
        next: 'status:blocked',
        comment: blockerReport,
      }).valid,
      false,
    );
    assert.equal(
      validateStatusTransition({
        issue: issue('status:ready'),
        worker: 'codex',
        expected: 'status:ready',
        next: 'status:in-progress',
      }).valid,
      false,
    );
    assert.equal(
      validateStatusTransition({
        issue: issue(),
        worker: 'maintainer',
        expected: 'status:in-progress',
        next: 'status:blocked',
        comment: blockerReport,
      }).valid,
      false,
    );
  });

  it('requires structured blocker evidence and an open linked PR for review', () => {
    assert.equal(
      validateStatusTransition({
        issue: issue(),
        worker: 'codex',
        expected: 'status:in-progress',
        next: 'status:blocked',
        comment: 'The build failed.',
      }).valid,
      false,
    );
    assert.equal(
      validateStatusTransition({
        issue: issue(),
        worker: 'codex',
        expected: 'status:in-progress',
        next: 'status:review',
        hasPullRequest: false,
      }).valid,
      false,
    );
    assert.equal(
      validateStatusTransition({
        issue: issue(),
        worker: 'codex',
        expected: 'status:in-progress',
        next: 'status:review',
        hasPullRequest: true,
      }).valid,
      true,
    );
    assert.equal(
      validateStatusTransition({
        issue: issue('status:review'),
        worker: 'codex',
        expected: 'status:review',
        next: 'status:in-progress',
        hasPullRequest: false,
        hasClaim: true,
      }).valid,
      true,
    );
  });

  it('requires a resolution and completed dependencies before unblocking', () => {
    const blocked = issue('status:blocked', {
      body: acceptance.replace('Dependencies\nNone', 'Dependencies\n#41'),
      dependencies: [
        { number: 41, state: 'OPEN', status: 'status:in-progress' },
      ],
    });
    const unresolved = validateStatusTransition({
      issue: blocked,
      worker: 'codex',
      expected: 'status:blocked',
      next: 'status:ready',
      comment: '## Resolution\nFixed it.',
    });
    assert.ok(unresolved.errors.some((error) => error.includes('unresolved')));
    blocked.dependencies[0] = {
      number: 41,
      state: 'CLOSED',
      status: 'status:done',
    };
    assert.equal(
      validateStatusTransition({
        issue: blocked,
        worker: 'codex',
        expected: 'status:blocked',
        next: 'status:ready',
        comment: '## Resolution\nThe dependency merged.',
      }).valid,
      true,
    );
  });

  it('requires a closed issue, a merged linked PR, checked criteria, and a released claim before done', () => {
    const closed = issue('status:review', {
      body: acceptance.replace('- [ ]', '- [x]'),
      state: 'CLOSED',
    });
    assert.equal(
      validateStatusTransition({
        issue: closed,
        worker: 'codex',
        expected: 'status:review',
        next: 'status:done',
        hasMergedPullRequest: true,
      }).valid,
      true,
    );
    assert.equal(
      validateStatusTransition({
        issue: closed,
        worker: 'codex',
        expected: 'status:review',
        next: 'status:done',
        hasMergedPullRequest: false,
      }).valid,
      false,
    );
    assert.equal(
      validateStatusTransition({
        issue: { ...closed, body: acceptance },
        worker: 'codex',
        expected: 'status:review',
        next: 'status:done',
        hasMergedPullRequest: true,
      }).valid,
      false,
    );
    assert.equal(
      validateStatusTransition({
        issue: closed,
        worker: 'codex',
        expected: 'status:review',
        next: 'status:done',
        hasMergedPullRequest: true,
        hasActiveClaim: true,
      }).valid,
      false,
    );
  });

  it('allows triage recovery to done only after integration requirements pass', () => {
    const closed = issue('status:triage', {
      body: acceptance.replace('- [ ]', '- [x]'),
      state: 'CLOSED',
    });
    assert.equal(
      validateStatusTransition({
        issue: closed,
        worker: 'codex',
        expected: 'status:triage',
        next: 'status:done',
        hasMergedPullRequest: true,
      }).valid,
      true,
    );
    assert.equal(
      validateStatusTransition({
        issue: closed,
        worker: 'codex',
        expected: 'status:triage',
        next: 'status:done',
        hasMergedPullRequest: true,
        hasActiveClaim: true,
      }).valid,
      false,
    );
  });

  it('appends evidence and checks fresh labels after a status change', async () => {
    const events = [];
    const current = issue();
    const latest = issue('status:blocked');
    let reads = 0;
    await changeStatus({
      issue: current,
      worker: 'codex',
      expected: 'status:in-progress',
      next: 'status:blocked',
      comment: blockerReport,
      updateLabels: async (number, labels) => {
        events.push('labels');
        assert.equal(number, 42);
        assert.deepEqual(labels, [
          'priority:medium',
          'target:develop',
          'type:feature',
          'owner:codex',
          'status:blocked',
        ]);
      },
      postComment: async () => events.push('comment'),
      refetch: async () => (++reads < 3 ? current : latest),
    });
    assert.deepEqual(events, ['comment', 'labels']);
    assert.equal(reads, 3);
  });

  it('does not write status labels when fresh state or authorization changed', async () => {
    let writes = 0;
    await assert.rejects(
      changeStatus({
        issue: issue(),
        worker: 'codex',
        expected: 'status:in-progress',
        next: 'status:blocked',
        comment: blockerReport,
        updateLabels: async () => writes++,
        postComment: async () => true,
        refetch: async () => issue('status:triage'),
      }),
      /changed since it was first fetched/,
    );
    await assert.rejects(
      changeStatus({
        issue: issue(),
        worker: 'maintainer',
        expected: 'status:in-progress',
        next: 'status:blocked',
        comment: blockerReport,
        updateLabels: async () => writes++,
        postComment: async () => true,
        refetch: async () => issue(),
      }),
      /status was not changed/,
    );
    await assert.rejects(
      changeStatus({
        issue: issue('status:review', { state: 'CLOSED' }),
        worker: 'codex',
        expected: 'status:review',
        next: 'status:done',
        hasMergedPullRequest: true,
        updateLabels: async () => writes++,
        postComment: async () => true,
        refetch: async () => issue('status:review', { state: 'CLOSED' }),
      }),
      /status was not changed/,
    );
    assert.equal(writes, 0);
  });

  it('atomically completes a closed integrated issue with its full label set', async () => {
    const current = issue('status:review', {
      body: acceptance.replace('- [ ]', '- [x]'),
      state: 'CLOSED',
    });
    const done = {
      ...current,
      labels: current.labels.map((label) =>
        label === 'status:review' ? 'status:done' : label,
      ),
    };
    let writes = 0;
    const result = await changeStatus({
      issue: current,
      worker: 'codex',
      expected: 'status:review',
      next: 'status:done',
      hasMergedPullRequest: true,
      updateLabels: async (number, labels) => {
        writes += 1;
        assert.equal(number, 42);
        assert.equal(
          labels.filter((label) => label.startsWith('status:')).length,
          1,
        );
        assert.ok(labels.includes('status:done'));
        assert.ok(!labels.includes('status:review'));
      },
      postComment: async () => true,
      refetch: async () => (writes ? done : current),
    });
    assert.equal(result.labels.includes('status:done'), true);
    assert.equal(writes, 1);
  });

  it('adds progress comments without editing or replacing the issue body', async () => {
    let recorded;
    await appendProgress({
      issue: issue(),
      worker: 'codex',
      comment: 'Verified the focused test passed.',
      postComment: async (number, body) => (recorded = { number, body }),
    });
    assert.deepEqual(recorded, {
      number: 42,
      body: 'Verified the focused test passed.',
    });
    await assert.rejects(
      appendProgress({
        issue: issue(),
        worker: 'maintainer',
        comment: 'Wrong owner.',
        postComment: async () => true,
      }),
      /cannot be updated/,
    );
  });
});
