import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runIntegration } from './worker-integration-runner.mjs';

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

  it('merges only after exact-head policy evidence, metadata, dependencies, and checks are re-fetched', async () => {
    const headSha = 'a'.repeat(40);
    const baseSha = 'b'.repeat(40);
    const issue = {
      number: 24,
      state: 'open',
      title: '[FEATURE] Add a loading status atom',
      body: `## Objective\nAdd a reusable status atom.\n\n## Context\nA small trial.\n\n## Expected outcome\nA reusable loading-aware status atom.\n\n## Acceptance criteria\n- [ ] Add the atom and its tests.\n\n## Constraints\nOnly the scoped component files.\n\n## Dependencies\nNone\n\n## Agent integration scope\nRisk: low\nAllowed files:\n- \`libs/ui/atoms/src/lib/status-label-atom.component.ts\`\n\n## Verification expectations\nRun focused tests.`,
      labels: [
        'priority:medium',
        'target:develop',
        'type:feature',
        'status:review',
        'worker:peon',
        'agent:automerge',
      ].map((name) => ({ name })),
    };
    const pull = {
      number: 300,
      state: 'open',
      draft: false,
      body: 'Fixes #24',
      base: { ref: 'develop' },
      head: {
        ref: 'issue/24-loading-status-atom',
        sha: headSha,
        repo: { full_name: 'Stellar-AI-Corp/Stellar' },
      },
      user: { login: 'integration-bot' },
    };
    const codeowners =
      '/tools/policy/ @DanielssonThomas\n/.github/workflows/ @DanielssonThomas';
    const mergeSha = 'c'.repeat(40);
    const calls = [];
    const request = async (path, options = {}) => {
      calls.push({ path, method: options.method ?? 'GET', body: options.body });
      if (path.startsWith('/issues/24/dependencies/blocked_by'))
        return response(200, []);
      if (path === '/issues/24') return response(200, issue);
      if (path === '/pulls/300') return response(200, pull);
      if (path.startsWith('/pulls/300/commits'))
        return response(200, [
          { commit: { message: '[#24] feat(atom): add loading status atom' } },
        ]);
      if (path.startsWith('/pulls/300/files'))
        return response(200, [
          {
            status: 'added',
            filename: 'libs/ui/atoms/src/lib/status-label-atom.component.ts',
          },
        ]);
      if (path.startsWith(`/commits/${headSha}/check-runs`))
        return response(200, {
          check_runs: [
            { name: 'verify', head_sha: headSha, conclusion: 'success' },
          ],
        });
      if (path === '/branches/develop')
        return response(200, { commit: { sha: baseSha } });
      if (path.startsWith('/contents/.github/CODEOWNERS'))
        return response(200, {
          encoding: 'base64',
          content: Buffer.from(codeowners).toString('base64'),
        });
      if (path === '/@root/user')
        return response(200, { login: 'integration-bot' });
      if (path === '/pulls/300/merge' && options.method === 'PUT')
        return response(200, { merged: true, sha: mergeSha });
      if (path === '/issues/24/comments' && options.method === 'POST')
        return response(201, { id: 301 });
      throw new Error(`Unexpected mock request ${path}`);
    };

    const result = await runIntegration({
      operation: 'integrate',
      issueNumber: 24,
      pullNumber: 300,
      repository: 'DanielssonThomas/Stellar',
      workerPolicy: [{ id: 'peon', forkFullName: 'Stellar-AI-Corp/Stellar' }],
      request,
    });

    assert.deepEqual(result, { merged: true, headSha, mergeSha });
    const merge = calls.find((call) => call.path === '/pulls/300/merge');
    assert.deepEqual(merge.body, { sha: headSha, merge_method: 'squash' });
    assert.equal(
      calls.filter((call) => call.path === '/branches/develop').length,
      2,
    );
    assert.equal(calls.filter((call) => call.path === '/issues/24').length, 2);
  });
});
