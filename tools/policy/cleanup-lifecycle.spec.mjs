import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assessCleanup } from './cleanup-lifecycle.mjs';

const head = 'a'.repeat(40);
const branch = 'issue/42-safe-task';
const path = '/tmp/stellar-issue-42';
const base = {
  phase: 'merged',
  claim: { state: 'released', branch, worktreePath: path },
  registration: { branch, path },
  stopped: {
    workerExited: true,
    attemptContainersStopped: true,
    verificationStopped: true,
    issueNumber: 42,
    headSha: head,
  },
  handoff: {
    durable: true,
    recoveryRequired: false,
    status: 'integrated',
    task: { issueNumber: 42, branch, worktreePath: path },
    headSha: head,
  },
  status: '',
  ignoredStatus: '',
  head,
  remoteHead: head,
  issue: {
    number: 42,
    state: 'CLOSED',
    labels: ['target:develop', 'status:done'],
  },
  pr: {
    state: 'MERGED',
    baseRefName: 'develop',
    headRefName: branch,
    headRefOid: head,
    mergedAt: '2026-01-01T00:00:00Z',
    body: 'Fixes #42',
  },
  openPrs: [],
};

describe('fail-closed cleanup classification', () => {
  it('accepts exact squash merge evidence even when ancestry is unavailable', () => {
    assert.deepEqual(assessCleanup(base), { eligible: true, reasons: [] });
  });
  for (const [name, change, reason] of [
    [
      'active lease',
      { claim: { ...base.claim, state: 'active' } },
      'active-claim',
    ],
    ['dirty worktree', { status: ' M file' }, 'worktree-has-content'],
    ['untracked data', { status: '?? note.txt' }, 'worktree-has-content'],
    [
      'ignored data',
      { ignoredStatus: 'node_modules/cache' },
      'worktree-has-content',
    ],
    [
      'unpushed head',
      { remoteHead: 'b'.repeat(40) },
      'commit-not-preserved-on-remote',
    ],
    [
      'unmerged PR',
      { pr: { ...base.pr, state: 'OPEN', mergedAt: null } },
      'merge-not-verified',
    ],
    [
      'open PR using branch',
      { openPrs: [{ headRefName: branch }] },
      'open-pr-or-state-unknown',
    ],
    ['stale GitHub state', { pr: null }, 'merge-not-verified'],
    ['running process', { stopped: false }, 'process-or-container-unconfirmed'],
    [
      'failed worker',
      { handoff: { ...base.handoff, status: 'blocked' } },
      'handoff-not-final',
    ],
    [
      'cancelled worker',
      { handoff: { ...base.handoff, status: 'paused' } },
      'handoff-not-final',
    ],
    [
      'recovery required',
      {
        handoff: { ...base.handoff, recoveryRequired: true },
      },
      'handoff-not-final',
    ],
    [
      'conflicting registration',
      { registration: { branch: 'issue/99-other', path } },
      'registration-mismatch',
    ],
    [
      'protected branch',
      { claim: { ...base.claim, branch: 'main' } },
      'claim-or-branch-untrusted',
    ],
    ['missing state', { openPrs: null }, 'open-pr-or-state-unknown'],
    [
      'stale stop receipt',
      { stopped: { ...base.stopped, headSha: 'b'.repeat(40) } },
      'process-or-container-unconfirmed',
    ],
  ]) {
    it(`preserves ${name}`, () => {
      const decision = assessCleanup({ ...base, ...change });
      assert.equal(decision.eligible, false);
      assert.ok(decision.reasons.includes(reason));
    });
  }
  it('permits clean review-pending worktree retirement with remote head retained', () => {
    const decision = assessCleanup({
      ...base,
      phase: 'post-job',
      handoff: { ...base.handoff, status: 'review-pending' },
      issue: {
        number: 42,
        state: 'OPEN',
        labels: ['target:develop', 'status:review'],
      },
      pr: { ...base.pr, state: 'OPEN' },
    });
    assert.equal(decision.eligible, true);
  });
  it('accepts a merged PR after GitHub deleted its head branch', () => {
    assert.equal(assessCleanup({ ...base, remoteHead: null }).eligible, true);
  });
  it('supports an interrupted cleanup after its clean worktree was already removed', () => {
    assert.equal(
      assessCleanup({ ...base, registration: null, worktreeAbsent: true })
        .eligible,
      true,
    );
  });
});
