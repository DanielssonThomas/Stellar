import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runIntegration } from './worker-integration-runner.mjs';
import { createIntegrationFixture } from './integration-fixtures.mjs';

const response = (status, value = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

describe('trusted worker integration runner', () => {
  it('requires a credential and a valid trusted worker identity policy', async () => {
    await assert.rejects(
      runIntegration({
        operation: 'verify-credential',
        issueNumber: 34,
        repository: 'DanielssonThomas/Stellar',
        workerPolicy: [],
      }),
      /STELLAR_INTEGRATION_TOKEN is required/,
    );
    await assert.rejects(
      runIntegration({
        operation: 'verify-credential',
        issueNumber: 34,
        token: 'not-used-by-mock',
        repository: 'DanielssonThomas/Stellar',
        workerPolicy: [
          { id: 'Peon', forkFullName: 'bad', pullRequestActor: '' },
        ],
        request: async () => response(200),
      }),
      /invalid entry/,
    );
  });

  it('records a safe credential scope probe when repository access succeeds and admin access is denied', async () => {
    const calls = [];
    const request = async (path, options = {}) => {
      calls.push({ path, method: options.method ?? 'GET', body: options.body });
      if (path === '/@root/user')
        return response(200, { login: 'stellar-integration[bot]' });
      if (path === '')
        return response(200, { full_name: 'DanielssonThomas/Stellar' });
      if (path === '/issues/34') return response(200, { number: 34 });
      if (path === '/actions/permissions') return response(403);
      if (path === '/issues/34/comments') return response(201, { id: 999 });
      throw new Error(`Unexpected mock request ${path}`);
    };

    const result = await runIntegration({
      operation: 'verify-credential',
      issueNumber: 34,
      repository: 'DanielssonThomas/Stellar',
      workerPolicy: [],
      request,
    });

    assert.deepEqual(result, {
      actor: 'stellar-integration[bot]',
      repository: 'DanielssonThomas/Stellar',
      adminReadDenied: true,
      status: 403,
    });
    assert.ok(
      calls.some(
        (call) => call.path === '/actions/permissions' && call.method === 'GET',
      ),
    );
    assert.ok(
      calls.some(
        (call) => call.path === '/issues/34/comments' && call.method === 'POST',
      ),
    );
  });

  it('creates a linked PR from exactly one authorized fork branch and advances the issue after creation', async () => {
    const issue = {
      id: 1024,
      repository_url: 'https://api.github.com/repos/DanielssonThomas/Stellar',
      number: 24,
      state: 'open',
      title: '[FEATURE] Add a loading status atom',
      body: `## Objective\nAdd a reusable status atom.\n\n## Expected outcome\nA reusable loading-aware status atom.\n\n## Acceptance criteria\n- [ ] Add the atom and its tests.\n\n## Constraints\nOnly the scoped component files.\n\n## Dependencies\nNone\n\n## Verification expectations\nRun focused tests.`,
      labels: [
        'priority:medium',
        'target:develop',
        'type:feature',
        'status:in-progress',
        'worker:peon',
      ].map((name) => ({ name })),
    };
    const createdPull = {
      number: 300,
      body: 'Fixes #24',
      head: { sha: 'a'.repeat(40) },
      user: { login: 'integration-bot' },
    };
    const calls = [];
    const request = async (path, options = {}) => {
      calls.push({ path, method: options.method ?? 'GET', body: options.body });
      if (path.startsWith('/issues/24/dependencies/blocked_by'))
        return response(200, []);
      if (path === '/issues/24' && options.method === 'PATCH') {
        issue.labels = options.body.labels.map((name) => ({ name }));
        return response(200, issue);
      }
      if (path === '/issues/24') return response(200, issue);
      if (path.startsWith('/pulls?state=open')) return response(200, []);
      if (path === '/pulls' && options.method === 'POST')
        return response(201, createdPull);
      if (path === '/@root/user')
        return response(200, { login: 'integration-bot' });
      if (path === '/issues/24/comments' && options.method === 'POST')
        return response(201, { id: 301 });
      throw new Error(`Unexpected mock request ${path}`);
    };
    const fetchImpl = async (url) => {
      assert.match(
        String(url),
        /api\.github\.com\/repos\/Stellar-AI-Corp\/Stellar\/branches/,
      );
      return response(200, [{ name: 'issue/24-status-label-atom' }]);
    };

    const result = await runIntegration({
      operation: 'create-pr',
      issueNumber: 24,
      repository: 'DanielssonThomas/Stellar',
      workerPolicy: [{ id: 'peon', forkFullName: 'Stellar-AI-Corp/Stellar' }],
      request,
      fetchImpl,
    });

    assert.deepEqual(result, { pullRequest: 300, headSha: 'a'.repeat(40) });
    const prRequest = calls.find(
      (call) => call.path === '/pulls' && call.method === 'POST',
    );
    assert.equal(
      prRequest.body.head,
      'Stellar-AI-Corp:issue/24-status-label-atom',
    );
    assert.equal(prRequest.body.base, 'develop');
    assert.match(prRequest.body.body, /Fixes #24/);
    assert.ok(
      calls.some(
        (call) => call.path === '/issues/24' && call.method === 'PATCH',
      ),
    );
    assert.ok(
      calls.some(
        (call) => call.path === '/issues/24/comments' && call.method === 'POST',
      ),
    );
  });

  it('fails the boundary probe if the integration credential can read repository administration', async () => {
    const writes = [];
    const request = async (path, options = {}) => {
      if (path === '/@root/user')
        return response(200, { login: 'unexpected-admin' });
      if (path === '')
        return response(200, { full_name: 'DanielssonThomas/Stellar' });
      if (path === '/issues/34') return response(200, { number: 34 });
      if (path === '/actions/permissions')
        return response(200, { enabled: true });
      if (path === '/issues/34/comments') writes.push(options);
      return response(201);
    };

    await assert.rejects(
      runIntegration({
        operation: 'verify-credential',
        issueNumber: 34,
        repository: 'DanielssonThomas/Stellar',
        workerPolicy: [],
        request,
      }),
      /read repository Actions administration; least-privilege verification failed/,
    );
    assert.equal(writes.length, 0);
  });

  it('merges only after complete protected exact-head evidence is fetched twice', async () => {
    const fixture = createIntegrationFixture({
      onRequest: (route, options) => {
        if (route === '/pulls/300/merge' && options.method === 'PUT')
          return response(200, { merged: true, sha: 'c'.repeat(40) });
        if (route.endsWith('/comments') && options.method === 'POST')
          return response(201, { id: 301 });
      },
    });
    const result = await runIntegration({
      ...fixture.options,
      workerPolicy: fixture.workerPolicy,
      request: fixture.request,
      operation: 'integrate',
    });
    assert.deepEqual(result, {
      merged: true,
      headSha: 'a'.repeat(40),
      mergeSha: 'c'.repeat(40),
    });
    for (const route of [
      '',
      '/branches/develop',
      '/branches/develop/protection',
      '/issues/24',
    ])
      assert.equal(
        fixture.calls.filter((call) => call.path === route).length,
        2,
      );
    assert.equal(
      fixture.calls.filter((call) =>
        call.path.startsWith('/contents/.github/CODEOWNERS'),
      ).length,
      2,
    );
    assert.equal(
      fixture.calls.filter((call) => call.path.startsWith('/pulls/300/files'))
        .length,
      2,
    );
    assert.deepEqual(fixture.calls.find((call) => call.method === 'PUT').body, {
      sha: 'a'.repeat(40),
      merge_method: 'squash',
    });
  });
  for (const [name, mutate] of Object.entries({
    head: (state) => {
      state.pull.head.sha = 'd'.repeat(40);
      state.commits[0].sha = state.pull.head.sha;
      state.checks[0].head_sha = state.pull.head.sha;
    },
    scope: (state) => {
      state.issue.body += '\nChanged scope.';
    },
    policy: (state) => {
      state.protection.required_conversation_resolution.enabled = true;
    },
    checks: (state) => {
      state.checks[0].app.id = 999;
    },
    requiredChecks: (state) => {
      state.protection.required_status_checks.checks.push({
        context: 'security',
        app_id: 15368,
      });
      state.protection.required_status_checks.contexts.push('security');
    },
    dependencies: (state) => {
      state.issue.body = state.issue.body.replace(
        '## Dependencies\nNone',
        '## Dependencies\n#20',
      );
      state.dependencies = [
        {
          number: 20,
          id: 120,
          repository_url:
            'https://api.github.com/repos/DanielssonThomas/Stellar',
        },
      ];
      state.dependencyIssues[20] = {
        number: 20,
        id: 120,
        repository_url: 'https://api.github.com/repos/DanielssonThomas/Stellar',
        state: 'open',
        labels: [{ name: 'status:in-progress' }],
      };
    },
  }))
    it('denies final-refresh changes to ' + name, async () => {
      let captures = 0;
      const fixture = createIntegrationFixture({
        onRequest: (route, options, state) => {
          if (route === '' && ++captures === 2) mutate(state);
          if (route.endsWith('/comments') && options.method === 'POST')
            return response(201, { id: 301 });
        },
      });
      const result = await runIntegration({
        ...fixture.options,
        workerPolicy: fixture.workerPolicy,
        request: fixture.request,
        operation: 'integrate',
      });
      assert.equal(result.merged, false);
      assert.equal(
        fixture.calls.some((call) => call.method === 'PUT'),
        false,
      );
    });
  it('rejects invalid credentials and unknown protection rather than merging', async () => {
    for (const status of [401, 403, 404]) {
      const fixture = createIntegrationFixture({
        onRequest: (route) =>
          route === '/branches/develop/protection'
            ? response(status)
            : undefined,
      });
      await assert.rejects(
        runIntegration({
          ...fixture.options,
          workerPolicy: fixture.workerPolicy,
          request: fixture.request,
          operation: 'integrate',
        }),
      );
      assert.equal(
        fixture.calls.some((call) => call.method === 'PUT'),
        false,
      );
    }
  });
});
