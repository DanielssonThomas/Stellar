import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertReviewResumeStatus,
  reconcileClaimStatus,
} from './manage-issue-worktree.mjs';

const fixture = (status = 'status:ready', owner = 'owner:codex') => ({
  number: 42,
  body: '## Objective\nDo it.\n\n## Expected outcome\nIt works.\n\n## Acceptance criteria\n- [ ] It works.\n\n## Constraints\nKeep scope.\n\n## Dependencies\nNone\n\n## Verification expectations\nRun tests.',
  state: 'OPEN',
  labels: [
    'priority:medium',
    'target:develop',
    'type:bug',
    status,
    owner,
    'area:ui',
  ],
  dependencies: [],
});

describe('claim status reconciliation', () => {
  it('permits a lost status-write response to be retried only by the same live session', async () => {
    const reviewPr = {
      number: 80,
      state: 'OPEN',
      headRefOid: 'a'.repeat(40),
      headRefName: 'issue/42-test',
      baseRefName: 'develop',
      body: 'Fixes #42',
    };
    let live = fixture('status:review');
    assertReviewResumeStatus({
      issue: live,
      worker: 'codex',
      sessionId: 'one',
    });
    await assert.rejects(
      reconcileClaimStatus({
        issueNumber: 42,
        worker: 'codex',
        resumed: false,
        reviewPr,
        fetchReview: async () => reviewPr,
        fetchIssue: async () => structuredClone(live),
        updateLabels: async (_number, labels) => {
          live = { ...live, labels };
          throw new Error('response lost after status write');
        },
      }),
      /response lost/,
    );
    const claim = {
      state: 'active',
      worker: 'owner:codex',
      sessionId: 'one',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    assertReviewResumeStatus({
      issue: live,
      claim,
      worker: 'codex',
      sessionId: 'one',
    });
    for (const rejected of [
      { claim, worker: 'codex', sessionId: 'other' },
      {
        claim: { ...claim, state: 'released' },
        worker: 'codex',
        sessionId: 'one',
      },
      {
        claim: { ...claim, expiresAt: new Date(0).toISOString() },
        worker: 'codex',
        sessionId: 'one',
      },
      {
        claim: { ...claim, worker: 'owner:maintainer' },
        worker: 'codex',
        sessionId: 'one',
      },
    ])
      assert.throws(
        () => assertReviewResumeStatus({ issue: live, ...rejected }),
        /same authorized session/,
      );
    await reconcileClaimStatus({
      issueNumber: 42,
      worker: 'codex',
      resumed: true,
      reviewPr,
      fetchReview: async () => reviewPr,
      fetchIssue: async () => structuredClone(live),
      updateLabels: async () => assert.fail('already written'),
    });
  });
  it('returns a review-stage issue to implementation only while the PR remains current', async () => {
    let live = fixture('status:review');
    const reviewPr = {
      number: 80,
      state: 'OPEN',
      headRefOid: 'a'.repeat(40),
      headRefName: 'issue/42-test',
      baseRefName: 'develop',
      body: 'Fixes #42',
    };
    await reconcileClaimStatus({
      issueNumber: 42,
      worker: 'codex',
      resumed: false,
      reviewPr,
      fetchReview: async () => reviewPr,
      fetchIssue: async () => structuredClone(live),
      updateLabels: async (_number, labels) => {
        live = { ...live, labels };
      },
    });
    assert.ok(live.labels.includes('status:in-progress'));
    live = fixture('status:review');
    await assert.rejects(
      reconcileClaimStatus({
        issueNumber: 42,
        worker: 'codex',
        resumed: false,
        reviewPr,
        fetchReview: async () => ({ ...reviewPr, headRefOid: 'b'.repeat(40) }),
        fetchIssue: async () => structuredClone(live),
        updateLabels: async () =>
          assert.fail('stale PR must not change issue status'),
      }),
      /PR changed/,
    );
  });
  it('uses current state after stale reads and preserves unrelated labels', async () => {
    let live = fixture();
    let reads = 0;
    let writes = 0;
    const fetchIssue = async () => {
      reads += 1;
      if (reads === 2) live = fixture('status:in-progress');
      return structuredClone(live);
    };
    await reconcileClaimStatus({
      issueNumber: 42,
      worker: 'codex',
      resumed: false,
      fetchIssue,
      updateLabels: async () => {
        writes += 1;
      },
    });
    assert.equal(writes, 0);
    assert.ok(live.labels.includes('area:ui'));
  });

  it('reconciles a policy triage overwrite for the same recovered worktree claim', async () => {
    let live = fixture();
    let writes = 0;
    await reconcileClaimStatus({
      issueNumber: 42,
      worker: 'codex',
      resumed: true,
      fetchIssue: async () => structuredClone(live),
      updateLabels: async (_number, labels) => {
        writes += 1;
        if (writes === 1) {
          live = fixture('status:triage');
          return;
        }
        live = { ...live, labels };
      },
    });
    assert.equal(writes, 2);
    assert.deepEqual(
      live.labels.filter((label) => label.startsWith('status:')),
      ['status:in-progress'],
    );
    assert.ok(live.labels.includes('area:ui'));
  });

  it('rejects changed ownership or an invalid status without writing', async () => {
    for (const live of [
      fixture('status:ready', 'worker:peon'),
      fixture('status:blocked'),
    ]) {
      let writes = 0;
      await assert.rejects(
        reconcileClaimStatus({
          issueNumber: 42,
          worker: 'codex',
          resumed: true,
          fetchIssue: async () => live,
          updateLabels: async () => {
            writes += 1;
          },
        }),
      );
      assert.equal(writes, 0);
    }
  });

  it('recovers when an atomic update committed but the client lost its response', async () => {
    let live = fixture();
    await assert.rejects(
      reconcileClaimStatus({
        issueNumber: 42,
        worker: 'codex',
        resumed: true,
        fetchIssue: async () => structuredClone(live),
        updateLabels: async (_number, labels) => {
          live = { ...live, labels };
          throw new Error('connection lost after server commit');
        },
      }),
      /connection lost/,
    );
    const recovered = await reconcileClaimStatus({
      issueNumber: 42,
      worker: 'codex',
      resumed: true,
      fetchIssue: async () => structuredClone(live),
      updateLabels: async () =>
        assert.fail('already in progress; should not write'),
    });
    assert.deepEqual(
      recovered.labels.filter((label) => label.startsWith('status:')),
      ['status:in-progress'],
    );
  });
});
