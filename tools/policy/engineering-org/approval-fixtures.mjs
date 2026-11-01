import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  createIntegrationFixture,
  response,
} from '../integration-fixtures.mjs';
import { createGitHubRequest } from '../integration-client.mjs';
import { createHostFixture } from './host-fixtures.mjs';
import {
  createRepositoryAdmission,
  repositoryIssueDigest,
} from './host-context.mjs';
import { createEngineeringHost } from './host-engine.mjs';
import { openHostStore } from './host-store.mjs';
import { digest } from './planning-evidence.mjs';

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export async function createApprovalSourceFixture() {
  const fixture = await createHostFixture();
  fixture.issue.body +=
    '\n## Agent integration scope\nRisk: low\nAllowed files:\n- `widget.mjs`\n';
  const record = JSON.parse(
    await readFile(fixture.options.scopeRecordPath, 'utf8'),
  );
  record.issueDigest = repositoryIssueDigest(fixture.issue);
  await writeFile(fixture.options.scopeRecordPath, JSON.stringify(record));
  fixture.options.scopeRecordDigest = digest(record);
  fixture.hostOptions.admission = createRepositoryAdmission(fixture.options);
  fixture.host = await createEngineeringHost(fixture.hostOptions);
  const result = await fixture.host.run(fixture.request);
  if (result.value.status !== 'ready-for-integration-review')
    throw new Error('Source fixture did not complete.');
  const grantId = result.value.grantId;
  const store = await openHostStore(fixture.hostOptions.storeRoot);
  const grant = await store.read(`${grantId}.grant`);
  const source = {
    grantId,
    grantDigest: grant.digest,
    attemptDigest: (await store.read(`${grantId}.attempt.result`)).digest,
    reviewDigest: (await store.read(`${grantId}.review`)).digest,
  };
  await writeFile(
    path.join(fixture.worktree, 'widget.mjs'),
    'export const value = 2;\n',
  );
  git(fixture.worktree, 'add', 'widget.mjs');
  git(
    fixture.worktree,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'core.hooksPath=',
    'commit',
    '-m',
    '[#42] feat(widget): return the required value',
  );
  return {
    ...fixture,
    source,
    baseSha: grant.value.facts.sourceRevision,
    headSha: git(fixture.worktree, 'rev-parse', 'HEAD').trim(),
    blobSha: git(fixture.worktree, 'rev-parse', 'HEAD:widget.mjs').trim(),
  };
}

export async function serveApprovalFixture(sourceFixture, onRequest) {
  const api = createIntegrationFixture({
    onRequest: async (route, options, state, calls) => {
      const override = await onRequest?.(route, options, state, calls);
      if (override !== undefined) return override;
      const url = new URL(route || '/', 'https://fixture.invalid');
      if (url.pathname === '/contents/widget.mjs') {
        const content = git(
          sourceFixture.worktree,
          'show',
          `${url.searchParams.get('ref')}:widget.mjs`,
        );
        const bytes = Buffer.from(content);
        return response(200, {
          type: 'file',
          encoding: 'base64',
          size: bytes.length,
          content: bytes.toString('base64'),
          sha: createHash('sha1')
            .update(`blob ${bytes.length}\0`)
            .update(bytes)
            .digest('hex'),
        });
      }
    },
  });
  Object.assign(api.state.issue, {
    id: 142,
    number: 42,
    title: sourceFixture.issue.title,
    body: sourceFixture.issue.body,
  });
  api.state.issue.labels = [
    'priority:low',
    'review:standard',
    'target:develop',
    'type:bug',
    'status:review',
    'worker:peon',
    'agent:automerge',
  ].map((name) => ({ name }));
  api.state.pull.body = 'Fixes #42';
  api.state.pull.head.sha = sourceFixture.headSha;
  api.state.pull.head.ref = 'issue/42-small-widget';
  api.state.pull.base.sha = sourceFixture.baseSha;
  api.state.target.commit.sha = sourceFixture.baseSha;
  api.state.commits[0].sha = sourceFixture.headSha;
  api.state.commits[0].parents = [{ sha: sourceFixture.baseSha }];
  api.state.commits[0].commit.message =
    '[#42] feat(widget): return the required value';
  api.state.files = [
    {
      sha: sourceFixture.blobSha,
      filename: 'widget.mjs',
      status: 'modified',
      additions: 1,
      deletions: 1,
      changes: 2,
    },
  ];
  api.state.checks[0].head_sha = sourceFixture.headSha;
  const server = createServer(async (incoming, outgoing) => {
    try {
      if (incoming.headers.authorization !== 'Bearer inert-test-token') {
        outgoing.writeHead(401).end('{}');
        return;
      }
      let text = '';
      for await (const part of incoming) {
        text += part;
        if (text.length > 32768) throw new Error('Fixture request too large.');
      }
      const prefix = '/repos/DanielssonThomas/Stellar';
      const route = incoming.url.startsWith(prefix)
        ? incoming.url.slice(prefix.length)
        : `/@root${incoming.url}`;
      const result = await api.request(route, {
        method: incoming.method,
        ...(text ? { body: JSON.parse(text) } : {}),
      });
      outgoing
        .writeHead(result.status, { 'Content-Type': 'application/json' })
        .end(await result.text());
    } catch (error) {
      outgoing
        .writeHead(500, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const apiUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    ...api,
    apiUrl,
    request: createGitHubRequest({
      token: 'inert-test-token',
      repository: api.options.repository,
      apiUrl,
    }),
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
