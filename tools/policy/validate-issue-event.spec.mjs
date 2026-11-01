import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  processIssueEvent,
  validateIssue,
  validateNativeDependencies,
} from './validate-issue.mjs';
import { createDependencyFixture } from './issue-dependency-fixtures.mjs';

describe('issue policy native dependency evidence', () => {
  it('validates complete local identities through multiple bounded REST pages', async () => {
    for (const count of [100, 101]) {
      const f = createDependencyFixture(
        Array.from({ length: count }, (_, index) => index + 100),
      );
      assert.deepEqual(await validateNativeDependencies(f.state.issue, f), []);
      assert.ok(f.calls.some((route) => route.endsWith('page=2')));
      assert.ok(f.calls.includes(`/issues/${99 + count}`));
    }
  });

  it('rejects foreign, substituted, duplicated and incomplete evidence before any policy write', async () => {
    for (const mutate of [
      (f) => {
        f.state.native[0].repository_url =
          'https://api.github.com/repos/foreign/project';
        f.state.native[0].state = 'open';
      },
      (f) => {
        f.state.fetched[23].id += 1;
      },
      (f) => {
        f.state.native[0].id = f.state.issue.id;
      },
      (f) => {
        delete f.state.native[0].id;
      },
      (f) => {
        delete f.state.native[0].repository_url;
      },
      (f) => {
        f.state.native[0].pull_request = {};
      },
      (f) => {
        f.state.native.push(structuredClone(f.state.native[0]));
      },
      (f) => {
        f.state.native = [];
      },
      (f) => {
        f.state.pages.set(1, { status: 404, value: {} });
      },
      (f) => {
        f.state.pages.set(1, { status: 200, value: {} });
      },
    ]) {
      const f = createDependencyFixture();
      mutate(f);
      let writes = 0;
      await assert.rejects(
        processIssueEvent({
          issueNumber: 42,
          fetchIssue: async () => structuredClone(f.state.issue),
          validateCurrent: async (current) => {
            await validateNativeDependencies(current, f);
            return validateIssue(current);
          },
          updateLabels: async () => {
            writes += 1;
          },
          ensureTriage: async () => {
            writes += 1;
          },
        }),
        /identity|match|duplicated|404|bounded list/,
      );
      assert.equal(writes, 0);
    }
  });

  it('preserves incomplete triage and reports read failures without relabeling it', async () => {
    const f = createDependencyFixture();
    f.state.issue.labels = [{ name: 'status:triage' }];
    f.state.issue.body = null;
    assert.deepEqual(await validateNativeDependencies(f.state.issue, f), []);
    assert.deepEqual(f.calls, []);
    const active = createDependencyFixture([23, 24]);
    active.state.pages.set(1, {
      status: 200,
      value: [active.state.native[0]],
      link: `<${active.repositoryUrl}/issues/42/dependencies/blocked_by?page=2&per_page=100>; rel="next"`,
    });
    active.state.pages.set(2, { status: 503, value: {} });
    const second = active.state.pages.get(2);
    active.state.pages.set(2, { status: 200, value: [active.state.native[1]] });
    assert.deepEqual(
      await validateNativeDependencies(active.state.issue, active),
      [],
    );
    const initialLink = active.state.pages.get(1).link;
    active.state.pages.get(1).link =
      `${initialLink}, ${initialLink.replace('page=2', 'page=3').replace('rel="next"', 'rel="last"')}`;
    await assert.rejects(
      validateNativeDependencies(active.state.issue, active),
      /advertised last page/,
    );
    active.state.pages.get(1).link = initialLink;
    active.calls.length = 0;
    active.state.pages.set(2, second);
    await assert.rejects(
      validateNativeDependencies(active.state.issue, active),
      /503/,
    );
    assert.equal(
      active.calls.some((route) => route === '/issues/23'),
      false,
    );
  });

  it('rejects wrong pagination identity, hidden later pages and the bounded list ceiling', async () => {
    const f = createDependencyFixture();
    const next = `<${f.repositoryUrl}/issues/42/dependencies/blocked_by?per_page=100&page=2>; rel="next"`;
    for (const link of [
      next.replace('api.github.com', 'foreign.example'),
      next.replace('/issues/42/', '/issues/43/'),
      next.replace('rel="next"', 'rel="last"'),
      `${next}, ${next.replace('page=2', 'page=1').replace('rel="next"', 'rel="last"')}`,
      Array(2)
        .fill(
          next.replace('page=2', 'page=1').replace('rel="next"', 'rel="first"'),
        )
        .join(', '),
    ]) {
      f.state.pages.set(1, { status: 200, value: f.state.native, link });
      await assert.rejects(
        validateNativeDependencies(f.state.issue, f),
        /pagination/,
      );
      assert.equal(f.calls.includes('/issues/23'), false);
    }
    const full = createDependencyFixture(
      Array.from({ length: 100 }, (_, index) => index + 100),
    );
    for (let page = 1; page <= 10; page += 1)
      full.state.pages.set(page, { status: 200, value: full.state.native });
    await assert.rejects(
      validateNativeDependencies(full.state.issue, full),
      /pagination limit/,
    );
    assert.equal(full.calls.length, 10);
    assert.equal(full.calls.includes('/issues/100'), false);
  });
});

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
      ensureTriage: async () => undefined,
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
      ensureTriage: async () => undefined,
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
      ensureTriage: async () => undefined,
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
        ensureTriage: async () => undefined,
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
      ensureTriage: async () => undefined,
      validateCurrent: async () => ({ errors: [] }),
    });
    assert.equal(recovered.changed, false);
  });
});
