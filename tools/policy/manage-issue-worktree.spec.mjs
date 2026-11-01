import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertReviewResumeStatus,
  loadIssue,
  reconcileClaimStatus,
  windowsProcessReferencesWorktree,
  wslProcessReferencesIssueWorkspace,
} from './manage-issue-worktree.mjs';
import { createDependencyFixture } from './issue-dependency-fixtures.mjs';
import { assertRepositoryIssue } from './issue-dependency-identity.mjs';
import { validateAssignment } from './issue-worktree.mjs';
import {
  validateFreshIssue,
  validateStatusTransition,
} from './update-issue.mjs';

const loadFixtureIssue = (fixture) =>
  loadIssue(42, {
    repository: fixture.repository,
    runCommand: fixture.runCommand,
  });

describe('native dependency identity acquisition', () => {
  it('retains exact local identities and existing claim/readiness state semantics', () => {
    const f = createDependencyFixture();
    const issue = loadFixtureIssue(f);
    assert.equal(issue.state, 'OPEN');
    assert.deepEqual(issue.dependencies, [
      {
        id: 2023,
        number: 23,
        repository_url: f.repositoryUrl,
        state: 'CLOSED',
        status: 'status:done',
      },
    ]);
    assert.equal(validateFreshIssue(issue, 'codex').valid, true);
    assert.equal(
      validateAssignment({
        issue,
        worker: 'codex',
        targetBranch: 'develop',
        existingBranches: ['develop'],
        dependencies: issue.dependencies,
      }).valid,
      true,
    );
    issue.labels = issue.labels.map((label) =>
      label.name === 'status:ready' ? { name: 'status:triage' } : label,
    );
    assert.equal(
      validateStatusTransition({
        issue,
        worker: 'codex',
        expected: 'status:triage',
        next: 'status:ready',
      }).valid,
      true,
    );
  });

  it('can inspect incomplete triage while preventing its promotion and preserving verified dependencies', () => {
    const f = createDependencyFixture();
    f.state.issue.body = null;
    f.state.issue.labels = [{ name: 'status:triage' }, { name: 'owner:codex' }];
    const issue = loadFixtureIssue(f);
    assert.equal(issue.body, '');
    assert.equal(issue.dependencies[0].id, 2023);
    assert.equal(
      validateStatusTransition({
        issue,
        worker: 'codex',
        expected: 'status:triage',
        next: 'status:ready',
      }).valid,
      false,
    );
    f.state.native[0].repository_url =
      'https://api.github.com/repos/foreign/project';
    assert.throws(() => loadFixtureIssue(f), /invalid identity/);
  });

  it('never substitutes a local closed issue for foreign or incomplete native evidence', () => {
    for (const change of [
      (f) => {
        f.state.native[0].repository_url =
          'https://api.github.com/repos/foreign/project';
        f.state.native[0].state = 'open';
      },
      (f) => {
        f.state.native[0].id += 1;
      },
      (f) => {
        delete f.state.native[0].id;
      },
      (f) => {
        delete f.state.native[0].repository_url;
      },
      (f) => {
        f.state.native[0].pull_request = null;
      },
      (f) => {
        f.state.fetched[23].pull_request = {};
      },
      (f) => {
        f.state.fetched[23].repository_url += '?substituted=true';
      },
      (f) => {
        f.state.fetched[23].number = 24;
      },
      (f) => {
        delete f.state.fetched[23].state;
      },
      (f) => {
        delete f.state.fetched[23].labels;
      },
      (f) => {
        delete f.state.issue.id;
      },
      (f) => {
        f.state.native.push(structuredClone(f.state.native[0]));
      },
    ]) {
      const f = createDependencyFixture();
      change(f);
      assert.throws(
        () => loadFixtureIssue(f),
        /invalid identity|incomplete|duplicated/,
      );
    }
    const f = createDependencyFixture([23, 24]);
    f.state.native[1].id = f.state.native[0].id;
    assert.throws(() => loadFixtureIssue(f), /duplicated/);
    const self = createDependencyFixture();
    self.state.native[0].id = self.state.issue.id;
    assert.throws(() => loadFixtureIssue(self), /own identity/);
    assert.equal(self.calls.includes('/issues/23'), false);
    for (const expectedId of [0, -1, null, '2023'])
      assert.throws(
        () =>
          assertRepositoryIssue(f.state.fetched[23], {
            repository: f.repository,
            number: 23,
            expectedId,
          }),
        /invalid identity/,
      );
  });

  it('checks later pages, rejects broken links and refuses truncated body/native admission', () => {
    const f = createDependencyFixture([23, 24]);
    const next = `<${f.repositoryUrl}/issues/42/dependencies/blocked_by?per_page=100&page=2>; rel="next"`;
    f.state.pages.set(1, {
      status: 200,
      value: [f.state.native[0]],
      link: next,
    });
    f.state.pages.set(2, { status: 200, value: [f.state.native[1]] });
    assert.equal(loadFixtureIssue(f).dependencies.length, 2);
    assert.ok(f.calls.some((route) => route.endsWith('page=2')));
    f.state.pages.get(1).link =
      `${next}, ${next.replace('page=2', 'page=3').replace('rel="next"', 'rel="last"')}`;
    assert.throws(() => loadFixtureIssue(f), /advertised last page/);
    f.state.pages.get(1).link = next;
    f.state.native[1].repository_url =
      'https://api.github.com/repos/foreign/project';
    assert.throws(() => loadFixtureIssue(f), /invalid identity/);
    for (const link of [
      next.replace('page=2', 'page=1'),
      next.replace('/repos/', '/foreign/'),
      next.replace('api.github.com', 'foreign.example'),
      next.replace('rel="next"', 'rel="last"'),
      `${next}, ${next}`,
      `${next}, ${next.replace('page=2', 'page=1').replace('rel="next"', 'rel="last"')}`,
      Array(2)
        .fill(
          next.replace('page=2', 'page=1').replace('rel="next"', 'rel="first"'),
        )
        .join(', '),
      'malformed; rel="next"',
    ]) {
      f.state.pages.get(1).link = link;
      assert.throws(() => loadFixtureIssue(f), /pagination/);
    }
    f.state.pages.clear();
    f.state.native = [f.state.native[0]];
    assert.equal(validateFreshIssue(loadFixtureIssue(f), 'codex').valid, false);
    const full = createDependencyFixture(
      Array.from({ length: 100 }, (_, index) => index + 100),
    );
    assert.equal(loadFixtureIssue(full).dependencies.length, 100);
    assert.ok(full.calls.some((route) => route.endsWith('page=2')));
  });

  it('uses the GitHub CLI web hostname and rejects unsupported API bases before a subprocess', () => {
    const f = createDependencyFixture();
    assert.equal(loadFixtureIssue(f).number, 42);
    for (const apiUrl of [
      'https://github.com',
      'https://api.github.com.evil',
      'https://enterprise.example/api/v3',
      'http://api.github.com',
      'https://user@api.github.com',
    ]) {
      let invoked = false;
      assert.throws(
        () =>
          loadIssue(42, {
            apiUrl,
            runCommand: () => {
              invoked = true;
            },
          }),
        /GitHub.com API base/,
      );
      assert.equal(invoked, false);
    }
  });

  it('fails closed for failed or malformed REST reads and a complete pagination bound', () => {
    for (const response of [
      '[]',
      'HTTP/2.0 403 Forbidden\r\n\r\n{}',
      'HTTP/2.0 200 OK\r\n\r\n{',
      'HTTP/2.0 200 OK\r\nlink: a\r\nlink: b\r\n\r\n{}',
    ])
      assert.throws(() => loadIssue(42, { runCommand: () => response }));
    const f = createDependencyFixture(
      Array.from({ length: 100 }, (_, index) => index + 100),
    );
    for (let page = 1; page <= 10; page += 1)
      f.state.pages.set(page, { status: 200, value: f.state.native });
    assert.throws(() => loadFixtureIssue(f), /pagination limit/);
    assert.equal(
      f.calls.filter((route) => route.includes('blocked_by')).length,
      10,
    );
    assert.equal(
      f.calls.some((route) => route === '/issues/100'),
      false,
    );
  });
});

describe('expired review live-process guard', () => {
  it('treats a running Codex process on the exact worktree as active', () => {
    const worktree = 'D:\\ai-repositories\\stellar-issue-42';
    assert.equal(
      windowsProcessReferencesWorktree(
        [{ Name: 'codex.exe', CommandLine: `codex --cd "${worktree}"` }],
        worktree,
      ),
      true,
    );
    assert.equal(
      windowsProcessReferencesWorktree(
        [{ Name: 'codex.exe', CommandLine: `codex --cd "${worktree}0"` }],
        worktree,
      ),
      false,
    );
  });

  it('matches a complete WSL issue path without matching numeric prefixes', () => {
    assert.equal(
      wslProcessReferencesIssueWorkspace(
        ['node /home/peon/workspaces/issue-420/tools/worker.mjs'],
        42,
      ),
      false,
    );
    assert.equal(
      wslProcessReferencesIssueWorkspace(
        ['node /home/peon/workspaces/issue-42/tools/worker.mjs'],
        42,
      ),
      true,
    );
    assert.equal(
      wslProcessReferencesIssueWorkspace(
        ['hermes --in "/home/peon/workspaces/issue-42"'],
        42,
      ),
      true,
    );
  });
});

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
