import assert from 'node:assert/strict';
import test from 'node:test';
import { captureIntegrationEvidence } from './integration-evidence.mjs';
import { createIntegrationFixture, response } from './integration-fixtures.mjs';
import { digest } from './engineering-org/planning-evidence.mjs';

const capture = (fixture) =>
  captureIntegrationEvidence(fixture.request, fixture.options);

test('low-risk prose cannot override critical review labels or actual sensitive files', async () => {
  for (const filename of [null, 'libs/session/security.ts', 'AGENTS.md']) {
    const f = createIntegrationFixture();
    if (filename) {
      f.state.issue.body = f.state.issue.body.replace(
        f.state.files[0].filename,
        filename,
      );
      f.state.files[0].filename = filename;
    } else {
      f.state.issue.labels.find(
        (label) => label.name === 'review:standard',
      ).name = 'review:critical';
    }
    const result = await capture(f);
    assert.match(result.issue.body, /Risk: low/);
    assert.equal(result.facts.policy.reviewTier, 'critical');
    assert.equal(result.decision.eligible, false);
    assert.ok(
      result.decision.reasons.includes(
        'integration-risk-requires-critical-review',
      ),
    );
    assert.equal(
      result.decision.reasons.includes('protected-path-changed'),
      false,
    );
    if (!filename)
      assert.ok(result.facts.issue.labels.includes('review:critical'));
  }
  const ordinary = createIntegrationFixture();
  ordinary.state.issue.labels.find(
    (label) => label.name === 'review:standard',
  ).name = 'review:light';
  const admitted = await capture(ordinary);
  assert.equal(admitted.facts.policy.reviewTier, 'standard');
  assert.equal(admitted.decision.eligible, true);
  assert.ok(admitted.facts.issue.labels.includes('review:light'));
});

test('captures revision-bound complete evidence using only reads and keeps snapshots detached', async () => {
  const f = createIntegrationFixture();
  const first = await capture(f);
  assert.equal(first.decision.eligible, true);
  assert.equal(first.digest, digest(first.facts));
  assert.equal(first.policyDigest, digest(first.facts.policy));
  assert.equal(first.baseSha, f.state.target.commit.sha);
  assert.deepEqual(first.facts.policy.requiredChecks, [
    { name: 'verify', appId: 15368 },
  ]);
  assert.ok(f.calls.every((call) => call.method === 'GET'));
  assert.ok(
    f.calls.some(
      (call) =>
        call.path === `/contents/.github/CODEOWNERS?ref=${first.baseSha}`,
    ),
  );
  assert.ok(
    f.calls.some((call) => call.path === '/rulesets/7?includes_parents=true'),
  );
  f.state.issue.updated_at = '2099-01-01T00:00:00Z';
  f.state.checks[0].completed_at = '2099-01-01T00:00:00Z';
  assert.equal((await capture(f)).digest, first.digest);
  f.state.issue.title = 'Changed issue scope';
  assert.notEqual((await capture(f)).digest, first.digest);
  assert.equal(first.issue.title, 'Add loading status atom');
  first.issue.labels.length = 0;
  assert.ok(first.facts.issue.labels.length > 0);
});

test('binds relevant repository, actor, dependency, file, commit and protection changes', async () => {
  const changes = [
    (state) => {
      state.repository.id += 1;
    },
    (state) => {
      state.principal.id += 1;
    },
    (state) => {
      state.issue.body += '\nAdditional scope constraint.\n';
    },
    (state) => {
      state.pull.draft = true;
    },
    (state) => {
      state.pull.head.repo.id += 1;
    },
    (state) => {
      state.commits[0].author.id += 1;
    },
    (state) => {
      state.files[0].sha = 'd'.repeat(40);
    },
    (state) => {
      state.checks[0].id += 1;
    },
    (state) => {
      state.protection.required_status_checks.strict = false;
    },
    (state) => {
      state.rulesets[0].bypass_actors = [
        { actor_type: 'RepositoryRole', actor_id: 5, bypass_mode: 'always' },
      ];
    },
    (state) => {
      state.repository.allow_squash_merge = false;
    },
  ];
  for (const change of changes) {
    const f = createIntegrationFixture();
    const before = await capture(f);
    change(f.state);
    assert.notEqual((await capture(f)).digest, before.digest);
  }
});

for (const status of [401, 403, 404]) {
  test(`denies unavailable classic protection with HTTP ${status} instead of treating it as absent`, async () => {
    const f = createIntegrationFixture({
      onRequest: (route) =>
        route === '/branches/develop/protection'
          ? response(status, { message: 'Not Found' })
          : undefined,
    });
    await assert.rejects(capture(f), new RegExp(`returned ${status}`));
    assert.equal(
      f.calls.some((call) => call.path === '/@root/graphql'),
      false,
    );
  });
}

test('requires the configured check app, completed status and exact head', async () => {
  for (const change of [
    (check) => {
      check.app.id = 999;
    },
    (check) => {
      check.head_sha = 'e'.repeat(40);
    },
    (check) => {
      check.status = 'in_progress';
    },
    (check) => {
      check.conclusion = 'failure';
    },
  ]) {
    const f = createIntegrationFixture();
    change(f.state.checks[0]);
    const result = await capture(f);
    assert.equal(result.decision.eligible, false);
    assert.ok(
      result.decision.reasons.includes(
        'required-check-source-state-or-head-invalid',
      ),
    );
  }
  const missing = createIntegrationFixture();
  missing.state.checks = [];
  assert.equal((await capture(missing)).decision.eligible, false);
});

test('does not accept an old passing check over a newer pending or failed exact-head check', async () => {
  const f = createIntegrationFixture();
  f.state.checks.push({
    ...f.state.checks[0],
    id: 401,
    status: 'in_progress',
    conclusion: null,
  });
  assert.equal((await capture(f)).decision.eligible, false);
});

test('rejects unpinned and conflicting sources and requires verify in actual protection', async () => {
  const unpinned = createIntegrationFixture();
  delete unpinned.state.branchRules[1].parameters.required_status_checks[0]
    .integration_id;
  unpinned.state.protection.required_status_checks.checks[0].app_id = null;
  assert.ok(
    (await capture(unpinned)).decision.reasons.includes(
      'required-check-source-unpinned',
    ),
  );
  const conflicting = createIntegrationFixture();
  conflicting.state.protection.required_status_checks.checks[0].app_id = 999;
  assert.ok(
    (await capture(conflicting)).decision.reasons.includes(
      'required-check-source-conflict',
    ),
  );
  const missing = createIntegrationFixture();
  missing.state.branchRules = missing.state.branchRules.filter(
    (rule) => rule.type !== 'required_status_checks',
  );
  missing.state.protection.required_status_checks = null;
  assert.ok(
    (await capture(missing)).decision.reasons.includes(
      'required-verify-protection-missing',
    ),
  );
});

test('requires complete matching source and effective rule inventories without duplicates', async () => {
  for (const change of [
    (state) =>
      state.rulesets[0].rules.push({
        type: 'required_deployments',
        parameters: { required_deployment_environments: ['production'] },
      }),
    (state) =>
      state.rulesets[0].rules.push({ type: 'required_linear_history' }),
    (state) => state.rulesets[0].rules.pop(),
    (state) => state.rulesets[0].rules.push(state.rulesets[0].rules[0]),
    (state) => state.branchRules.push(state.branchRules[0]),
    (state) => {
      state.rulesets[0].rules.push(state.rulesets[0].rules[0]);
      state.branchRules.push(state.branchRules[0]);
    },
  ]) {
    const f = createIntegrationFixture();
    change(f.state);
    const result = await capture(f);
    assert.equal(result.decision.eligible, false);
    assert.ok(
      result.decision.reasons.includes('ruleset-rule-coverage-incomplete'),
    );
  }
  const reordered = createIntegrationFixture();
  const baseline = await capture(reordered);
  reordered.state.branchRules.reverse();
  reordered.state.rulesets[0].rules.reverse();
  assert.equal((await capture(reordered)).decision.eligible, true);
  assert.equal(baseline.decision.eligible, true);
});

test('denies unsupported or incomplete enforcement and hidden bypass policy', async () => {
  for (const [change, expected] of [
    [
      (state) => {
        delete state.rulesets[0].bypass_actors;
      },
      'ruleset-bypass-evidence-unavailable',
    ],
    [
      (state) => {
        state.rulesets[0].enforcement = 'evaluate';
      },
      'ruleset-provenance-incomplete',
    ],
    [
      (state) => {
        state.rulesets[0].source = 'other/repository';
      },
      'ruleset-provenance-incomplete',
    ],
    [
      (state) => {
        state.protection.enforce_admins.enabled = false;
      },
      'classic-admin-bypass-unsupported',
    ],
    [
      (state) => {
        state.protection = {};
      },
      'classic-protection-malformed',
    ],
    [
      (state) => {
        state.branchRules[0].parameters.required_approving_review_count = 1;
      },
      'review-policy-unsupported',
    ],
    [
      (state) => {
        state.branchRules[0].parameters.require_code_owner_review = true;
      },
      'review-policy-unsupported',
    ],
    [
      (state) => {
        state.branchRules[0].parameters.require_last_push_approval = true;
      },
      'review-policy-unsupported',
    ],
    [
      (state) => {
        state.branchRules[0].parameters.allowed_merge_methods = ['merge'];
      },
      'squash-merge-not-authorized',
    ],
    [
      (state) => {
        state.protection.required_signatures = { enabled: true };
      },
      'classic-protection-unsupported',
    ],
    [
      (state) => {
        state.branchRules.push({
          type: 'merge_queue',
          ruleset_id: 7,
          ruleset_source_type: 'Repository',
          ruleset_source: 'DanielssonThomas/Stellar',
        });
      },
      'branch-rule-unsupported',
    ],
  ]) {
    const f = createIntegrationFixture();
    change(f.state);
    const result = await capture(f);
    assert.equal(result.decision.eligible, false);
    assert.ok(
      result.decision.reasons.includes(expected),
      JSON.stringify(result.decision),
    );
  }
});

test('requires complete count-bound commit and file inventories and matching CODEOWNERS bytes', async () => {
  for (const change of [
    (state) => {
      state.pull.commits = 2;
    },
    (state) => {
      state.pull.changed_files = 2;
    },
    (state) => {
      state.commits[0].sha = 'e'.repeat(40);
    },
    (state) => {
      state.commits.push(state.commits[0]);
      state.pull.commits = 2;
    },
    (state) => {
      state.codeowners.content = Buffer.from('/other/ @attacker\n').toString(
        'base64',
      );
    },
    (state) => {
      state.codeowners.encoding = 'none';
    },
  ]) {
    const f = createIntegrationFixture();
    change(f.state);
    await assert.rejects(
      capture(f),
      /incomplete|duplicated|exact PR head|blob identity/,
    );
  }
});

test('reads all review-thread pages and never treats REST review approval as resolution', async () => {
  const f = createIntegrationFixture();
  f.state.branchRules[0].parameters.required_review_thread_resolution = true;
  f.state.threads = Array.from({ length: 101 }, (_, index) => ({
    id: `thread-${index}`,
    isResolved: true,
  }));
  const passed = await capture(f);
  assert.equal(passed.decision.eligible, true);
  assert.equal(passed.facts.reviewThreads.length, 101);
  assert.equal(
    f.calls.filter((call) => call.path === '/@root/graphql').length,
    2,
  );
  assert.ok(
    f.calls
      .filter((call) => call.method === 'POST')
      .every((call) =>
        call.body.query.startsWith('query IntegrationReviewThreads'),
      ),
  );
  f.state.threads[100].isResolved = false;
  const blocked = await capture(f);
  assert.ok(blocked.decision.reasons.includes('review-threads-unresolved'));
  assert.notEqual(blocked.digest, passed.digest);
  assert.equal(
    f.calls.some((call) => call.path.includes('/reviews')),
    false,
  );
});

test('fails closed on GraphQL errors, stale thread heads and absent thread pages', async () => {
  const invalid = [
    { errors: [{ message: 'Forbidden' }], data: null },
    {
      data: {
        repository: {
          databaseId: 100,
          nameWithOwner: 'DanielssonThomas/Stellar',
          pullRequest: {
            number: 300,
            headRefOid: 'f'.repeat(40),
            reviewThreads: {
              totalCount: 0,
              nodes: [],
              pageInfo: { hasNextPage: false },
            },
          },
        },
      },
    },
  ];
  for (const value of invalid) {
    const f = createIntegrationFixture({
      onRequest: (route) =>
        route === '/@root/graphql' ? response(200, value) : undefined,
    });
    f.state.protection.required_conversation_resolution.enabled = true;
    await assert.rejects(capture(f), /thread/);
  }
});

test('validates resolved native dependencies and invalidates their changed state', async () => {
  const f = createIntegrationFixture();
  f.state.issue.body = f.state.issue.body.replace(
    'Dependencies\nNone',
    'Dependencies\n#23',
  );
  f.state.dependencies = [
    { id: 123, number: 23, repository_url: f.state.issue.repository_url },
  ];
  f.state.dependencyIssues[23] = {
    id: 123,
    repository_url: f.state.issue.repository_url,
    number: 23,
    state: 'closed',
    labels: [{ name: 'status:done' }],
  };
  const passed = await capture(f);
  assert.equal(passed.decision.eligible, true);
  assert.equal(passed.facts.issue.dependencies[0].id, 123);
  assert.equal(
    passed.facts.issue.dependencies[0].repositoryUrl,
    f.state.issue.repository_url,
  );
  f.state.dependencyIssues[23].state = 'open';
  const failed = await capture(f);
  assert.ok(failed.decision.reasons.includes('unresolved-dependency'));
  assert.notEqual(failed.digest, passed.digest);
});

test('never substitutes a closed local issue for a foreign or mismatched native dependency', async () => {
  for (const change of [
    (state) => {
      Object.assign(state.dependencies[0], {
        id: 999,
        repository_url: 'https://api.github.com/repos/foreign/project',
        state: 'open',
      });
    },
    (state) => {
      state.dependencies[0].repository_url =
        'https://api.github.com/repos/foreign/project';
    },
    (state) => {
      state.dependencyIssues[23].id = 456;
    },
    (state) => {
      delete state.dependencies[0].id;
    },
    (state) => {
      delete state.dependencies[0].repository_url;
    },
    (state) => {
      delete state.dependencyIssues[23].id;
    },
    (state) => {
      state.dependencyIssues[23].repository_url =
        'https://api.github.com/repos/foreign/project';
    },
  ]) {
    const f = createIntegrationFixture();
    f.state.issue.body = f.state.issue.body.replace(
      'Dependencies\nNone',
      'Dependencies\n#23',
    );
    f.state.dependencies = [
      { id: 123, number: 23, repository_url: f.state.issue.repository_url },
    ];
    f.state.dependencyIssues[23] = {
      id: 123,
      number: 23,
      repository_url: f.state.issue.repository_url,
      state: 'closed',
      labels: [{ name: 'status:done' }],
    };
    change(f.state);
    await assert.rejects(
      capture(f),
      /repository or global identity is invalid|invalid identity/,
    );
  }
});
