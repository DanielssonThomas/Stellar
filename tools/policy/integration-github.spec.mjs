import assert from 'node:assert/strict';
import test from 'node:test';
import {
  issueContext,
  readAll,
  readCheckRuns,
  readJson,
  readReviewThreads,
} from './integration-github.mjs';
import { createIntegrationFixture, response } from './integration-fixtures.mjs';

test('strict JSON reads reject status errors unless an explicit non-policy caller permits 404', async () => {
  for (const status of [401, 403, 404, 500])
    await assert.rejects(
      readJson(async () => response(status), '/evidence'),
      new RegExp(String(status)),
    );
  assert.equal(
    await readJson(async () => response(404), '/optional', { allow404: true }),
    null,
  );
});

test('bounded list reads do not truncate a short page advertising another page', async () => {
  const routes = [];
  const list = await readAll(async (route) => {
    routes.push(route);
    return route.endsWith('page=1')
      ? new Response('[{"id":1}]', {
          status: 200,
          headers: { link: '<https://api.github.com/next>; rel="next"' },
        })
      : response(200, [{ id: 2 }]);
  }, '/items?state=open');
  assert.deepEqual(list, [{ id: 1 }, { id: 2 }]);
  assert.equal(routes.length, 2);
  await assert.rejects(
    readAll(
      async () =>
        response(
          200,
          Array.from({ length: 100 }, (_, id) => ({ id })),
        ),
      '/items',
    ),
    /pagination limit/,
  );
  await assert.rejects(
    readAll(async () => response(200, {}), '/items'),
    /invalid list/,
  );
});

test('check pagination rejects missing totals, repeated IDs, truncation and changing totals', async () => {
  const sha = 'a'.repeat(40);
  for (const value of [
    { check_runs: [] },
    { total_count: 1, check_runs: [] },
    { total_count: 2, check_runs: [{ id: 1 }, { id: 1 }] },
  ])
    await assert.rejects(
      readCheckRuns(async () => response(200, value), sha),
      /invalid|incomplete|duplicated/,
    );
  let page = 0;
  await assert.rejects(
    readCheckRuns(
      async () =>
        response(
          200,
          ++page === 1
            ? {
                total_count: 101,
                check_runs: Array.from({ length: 100 }, (_, index) => ({
                  id: index + 1,
                })),
              }
            : { total_count: 102, check_runs: [{ id: 101 }] },
        ),
      sha,
    ),
    /changed/,
  );
});

test('native dependency acquisition rejects duplicate and substituted issue identities', async () => {
  const f = createIntegrationFixture();
  f.state.issue.body = f.state.issue.body.replace(
    'Dependencies\nNone',
    'Dependencies\n#23\n#23',
  );
  f.state.dependencies = [{ number: 23 }, { number: 23 }];
  await assert.rejects(issueContext(f.request, 24, f.options), /do not match/);
  f.state.issue.body = f.state.issue.body.replace('#23\n#23', '#23');
  f.state.dependencies = [
    { id: 123, number: 23, repository_url: f.state.issue.repository_url },
  ];
  f.state.dependencyIssues[23] = {
    id: 123,
    number: 22,
    repository_url: f.state.issue.repository_url,
    state: 'closed',
    labels: [],
  };
  await assert.rejects(
    issueContext(f.request, 24, f.options),
    /invalid identity/,
  );
});

test('issue acquisition requires explicit repository context and full current issue provenance', async () => {
  const f = createIntegrationFixture();
  await assert.rejects(issueContext(f.request, 24), /trusted repository/);
  delete f.state.issue.id;
  await assert.rejects(
    issueContext(f.request, 24, f.options),
    /invalid identity/,
  );
  f.state.issue.id = 124;
  f.state.issue.repository_url = 'https://api.github.com/repos/foreign/project';
  await assert.rejects(
    issueContext(f.request, 24, f.options),
    /invalid identity/,
  );
});

test('review-thread acquisition rejects a nonadvancing cursor and silently truncated inventory', async () => {
  const options = {
    repository: 'DanielssonThomas/Stellar',
    repositoryId: 100,
    pullNumber: 300,
    headSha: 'a'.repeat(40),
  };
  const result = (connection) => ({
    data: {
      repository: {
        databaseId: 100,
        nameWithOwner: options.repository,
        pullRequest: {
          number: 300,
          headRefOid: options.headSha,
          reviewThreads: connection,
        },
      },
    },
  });
  await assert.rejects(
    readReviewThreads(
      async () =>
        response(
          200,
          result({
            totalCount: 1,
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          }),
        ),
      options,
    ),
    /incomplete/,
  );
  await assert.rejects(
    readReviewThreads(
      async () =>
        response(
          200,
          result({
            totalCount: 10,
            nodes: [{ id: 'one', isResolved: true }],
            pageInfo: { hasNextPage: true, endCursor: 'same' },
          }),
        ),
      options,
    ),
    /did not advance/,
  );
});
