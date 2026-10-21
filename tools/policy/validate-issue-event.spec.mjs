import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { processIssueEvent } from './validate-issue.mjs';

const issue = (status, labels = []) => ({
  number: 42,
  labels: [
    'priority:medium',
    'target:develop',
    'type:bug',
    'owner:codex',
    status,
    'area:ui',
    ...labels,
  ].map((name) => ({ name })),
});

describe('issue policy live-state reconciliation', () => {
  it('does not use an event snapshot when the live issue has a valid claim', async () => {
    let writes = 0;
    const current = issue('status:in-progress');
    const result = await processIssueEvent({
      issueNumber: 42,
      fetchIssue: async () => current,
      updateLabels: async () => {
        writes += 1;
      },
      ensureTriage: async () => {},
      validateCurrent: async () => ({ errors: [] }),
    });
    assert.equal(result.changed, false);
    assert.equal(writes, 0);
  });

  it('replaces a bad full label set once and preserves ownership and unrelated labels', async () => {
    let current = issue('status:in-progress', ['status:blocked']);
    const writes = [];
    const result = await processIssueEvent({
      issueNumber: 42,
      fetchIssue: async () => structuredClone(current),
      updateLabels: async (_number, labels) => {
        writes.push(labels);
        current = { ...current, labels: labels.map((name) => ({ name })) };
      },
      ensureTriage: async () => {},
      validateCurrent: async (fresh) => ({
        errors: fresh.labels.some((label) => label.name === 'status:triage')
          ? []
          : ['invalid'],
      }),
    });
    assert.equal(result.changed, true);
    assert.equal(writes.length, 1);
    assert.deepEqual(
      writes[0].filter((label) => label.startsWith('status:')),
      ['status:triage'],
    );
    assert.ok(writes[0].includes('owner:codex'));
    assert.ok(writes[0].includes('area:ui'));
  });

  it('re-fetches after an overlapping event changes labels before the write', async () => {
    let current = issue('status:ready');
    let reads = 0;
    let writes = 0;
    const result = await processIssueEvent({
      issueNumber: 42,
      fetchIssue: async () => {
        reads += 1;
        if (reads === 2) current = issue('status:in-progress');
        return structuredClone(current);
      },
      updateLabels: async () => {
        writes += 1;
      },
      ensureTriage: async () => {},
      validateCurrent: async (fresh) => ({
        errors: fresh.labels.some(
          (label) => label.name === 'status:in-progress',
        )
          ? []
          : ['old invalid state'],
      }),
    });
    assert.equal(result.changed, false);
    assert.equal(writes, 0);
  });

  it('stops after a bounded conflicting update and can observe a later valid recovery', async () => {
    let current = issue('status:blocked');
    let writes = 0;
    await assert.rejects(
      processIssueEvent({
        issueNumber: 42,
        maxAttempts: 1,
        fetchIssue: async () => structuredClone(current),
        updateLabels: async () => {
          writes += 1;
          current = issue('status:in-progress');
        },
        ensureTriage: async () => {},
        validateCurrent: async (fresh) => ({
          errors: fresh.labels.some((label) => label.name === 'status:triage')
            ? []
            : ['invalid'],
        }),
      }),
      /kept changing/,
    );
    assert.equal(writes, 1);
    const recovered = await processIssueEvent({
      issueNumber: 42,
      fetchIssue: async () => current,
      updateLabels: async () => assert.fail('live state is valid'),
      ensureTriage: async () => {},
      validateCurrent: async () => ({ errors: [] }),
    });
    assert.equal(recovered.changed, false);
  });
});
