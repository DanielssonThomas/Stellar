import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assessMergedIssue, linkedIssueNumber } from './post-merge-cleanup.mjs';

const head = 'a'.repeat(40);
const pr = {
  state: 'MERGED',
  mergedAt: '2026-10-25T00:00:00Z',
  headRefOid: head,
  baseRefName: 'develop',
  body: 'Fixes #42',
};
const issue = {
  number: 42,
  state: 'CLOSED',
  labels: ['owner:codex', 'target:develop', 'status:review'],
  body: '## Acceptance criteria\n- [x] Work is complete.\n\n## Dependencies\nNone',
};

describe('trusted merged issue completion', () => {
  it('requires one exact issue link and verified merge head', () => {
    assert.equal(linkedIssueNumber(pr.body), 42);
    assert.throws(
      () => linkedIssueNumber('Fixes #42 and fixes #43'),
      /exactly one/,
    );
    assert.deepEqual(
      assessMergedIssue({ pr, issue, expectedHead: head }).reasons,
      [],
    );
    assert.ok(
      assessMergedIssue({
        pr,
        issue,
        expectedHead: 'b'.repeat(40),
      }).reasons.includes('exact-merge-not-verified'),
    );
  });
  it('preserves unchecked work and mismatched targets or statuses', () => {
    assert.ok(
      assessMergedIssue({
        pr,
        issue: { ...issue, body: issue.body.replace('[x]', '[ ]') },
        expectedHead: head,
      }).reasons.includes('acceptance-not-complete'),
    );
    assert.ok(
      assessMergedIssue({
        pr,
        issue: {
          ...issue,
          labels: ['owner:codex', 'target:main', 'status:review'],
        },
        expectedHead: head,
      }).reasons.includes('exact-merge-not-verified'),
    );
    assert.ok(
      assessMergedIssue({
        pr,
        issue: {
          ...issue,
          labels: ['owner:codex', 'target:develop', 'status:blocked'],
        },
        expectedHead: head,
      }).reasons.includes('issue-status-not-completable'),
    );
  });
});
