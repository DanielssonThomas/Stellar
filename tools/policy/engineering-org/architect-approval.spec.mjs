import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createGitHubRequest } from '../integration-client.mjs';
import { response } from '../integration-fixtures.mjs';
import {
  createApprovalSourceFixture,
  serveApprovalFixture,
} from './approval-fixtures.mjs';
import { createArchitectApprovalHost } from './architect-approval.mjs';
import { inertApprovalRecipes } from './approval-recipes.mjs';
import { openHostStore } from './host-store.mjs';

let source;
before(async () => {
  source = await createApprovalSourceFixture();
});
after(async () => {
  if (source) await rm(source.root, { recursive: true, force: true });
});

async function fixture(t, options = {}) {
  const api = await serveApprovalFixture(source, options.onRequest);
  t.after(api.close);
  const config = {
    repository: api.options.repository,
    workerPolicy: api.workerPolicy,
    request: api.request,
    sourceStoreRoot: source.hostOptions.storeRoot,
    source: source.source,
    storeRoot: path.join(source.root, `approval-${randomUUID()}`),
    poolRoot: source.hostOptions.poolRoot,
    recipes: await inertApprovalRecipes(),
    authorizationId: `approval-${randomUUID()}`,
    ...(options.host ?? {}),
  };
  return {
    api,
    config,
    host: await createArchitectApprovalHost(config),
    request: { issueNumber: 42, pullNumber: 300, key: 'first-approval' },
  };
}

test('actual HTTP capture and separate role sessions bind an inert decision to the real PR commit', async (t) => {
  const f = await fixture(t);
  const result = await f.host.requestApproval(f.request);
  assert.equal(result.status, 'ready-for-offline-integration');
  assert.equal(result.headSha, source.headSha);
  assert.equal(result.liveExecutionAllowed, false);
  const store = await openHostStore(f.config.storeRoot);
  const foreman = (await store.read(`${result.id}.pr-review.result`)).value
    .receipt;
  const architect = (await store.read(`${result.id}.architect-approval.result`))
    .value.receipt;
  assert.equal(foreman.role, 'foreman');
  assert.equal(architect.role, 'architect');
  assert.notEqual(foreman.nonce, architect.nonce);
  assert.equal(foreman.result.headRevision, source.headSha);
  const old = await openHostStore(source.hostOptions.storeRoot);
  assert.notEqual(
    (await old.read(`${source.source.grantId}.review`)).value.report
      .headRevision,
    source.headSha,
  );
  const files = await readdir(f.config.storeRoot);
  assert.deepEqual(await f.host.requestApproval(f.request), result);
  assert.deepEqual(await readdir(f.config.storeRoot), files);
  await assert.rejects(
    f.host.requestApproval({ ...f.request, key: 'different-key' }),
    /already consumed/,
  );
  assert.equal((await f.host.integrate(result.id)).merged, false);
  assert.deepEqual(f.host.fallback(), {
    allowed: false,
    label: 'Not Architect approved',
    reasons: ['fallback-disabled'],
  });
  assert.ok(f.api.calls.every((call) => call.method === 'GET'));
  f.api.state.checks[0].id += 1;
  await assert.rejects(f.host.inspect(result.id), /changed/);
});

test('expiry is checked again after asynchronous fresh admission', async (t) => {
  let timestamp = Date.now();
  let expire = false;
  const f = await fixture(t, {
    host: { now: () => timestamp, lifetimeMs: 10_000 },
    onRequest: (route) => {
      if (expire && route === '') timestamp += 10_000;
    },
  });
  const result = await f.host.requestApproval(f.request);
  expire = true;
  await assert.rejects(f.host.inspect(result.id), /expired/);
});

for (const phase of ['pr-review', 'architect-approval'])
  for (const reserved of [false, true])
    test(`expiry during ${phase} admission ${reserved ? 'after' : 'before'} reservation prevents its child launch`, async (t) => {
      let timestamp = Date.now();
      const prerequisite = reserved
        ? `.${phase}.reservation`
        : phase === 'pr-review'
          ? '.approval-grant'
          : '.pr-review.result';
      const f = await fixture(t, {
        host: { now: () => timestamp, lifetimeMs: 10_000 },
        onRequest: async (route) => {
          if (
            storeRoot &&
            route === '' &&
            (await readdir(storeRoot)).some((file) =>
              file.endsWith(prerequisite),
            )
          )
            timestamp += 10_000;
        },
      });
      const storeRoot = f.config.storeRoot;
      await assert.rejects(f.host.requestApproval(f.request), /expired/);
      const files = await readdir(storeRoot);
      assert.equal(
        files.some((file) => file.endsWith(`.${phase}.launch`)),
        false,
      );
      assert.equal(
        files.some((file) => file.endsWith(`.${phase}.reservation`)),
        reserved,
      );
      assert.equal(
        files.some((file) => file.endsWith(`.${phase}.not-started`)),
        reserved,
      );
      if (phase === 'architect-approval')
        assert.ok(files.some((file) => file.endsWith('.pr-review.result')));
      assert.equal(existsSync(path.join(f.config.poolRoot, 'active')), false);
    });

test('expiry after session workspace creation records proven no-launch and releases capacity', async (t) => {
  const timestamp = Date.now();
  const f = await fixture(t, {
    host: {
      lifetimeMs: 10_000,
      now: () =>
        timestamp +
        (storeRoot &&
        readdirSync(storeRoot).some((file) =>
          file.endsWith('.pr-review.workspace'),
        )
          ? 10_000
          : 0),
    },
  });
  const storeRoot = f.config.storeRoot;
  await assert.rejects(
    f.host.requestApproval(f.request),
    (error) =>
      /before launch/.test(error.message) &&
      /expired/.test(error.cause.message),
  );
  const files = await readdir(storeRoot);
  assert.ok(files.some((file) => file.endsWith('.pr-review.reservation')));
  const record = files.find((file) => file.endsWith('.pr-review.not-started'));
  assert.ok(record);
  const store = await openHostStore(storeRoot);
  assert.equal(
    (await store.read(record)).value.reason,
    'host-pre-spawn-guard-rejected',
  );
  assert.equal(
    files.some((file) => file.endsWith('.launch')),
    false,
  );
  assert.equal(existsSync(path.join(f.config.poolRoot, 'active')), false);
  await assert.rejects(f.host.requestApproval(f.request), /expired/);
});

for (const phase of ['pr-review', 'architect-approval'])
  test(`${phase} provider failure never creates approval`, async (t) => {
    const f = await fixture(t, {
      host: { faults: { [phase]: 'provider-failure' } },
    });
    const result = await f.host.requestApproval(f.request);
    assert.equal(result.status, 'blocked');
    assert.equal(
      (await readdir(f.config.storeRoot)).some((file) =>
        file.endsWith('.approval'),
      ),
      false,
    );
    assert.equal(
      f.api.calls.some((call) => call.method === 'PUT'),
      false,
    );
  });

test('claims, credentials, current issue scope and nested storage cannot grant authority', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.host.requestApproval({
      ...f.request,
      caller: 'architect',
      approved: true,
    }),
    /only issue/,
  );
  await assert.rejects(
    createArchitectApprovalHost({
      ...f.config,
      storeRoot: path.join(f.config.sourceStoreRoot, 'nested-approval'),
    }),
    /separate host roots/,
  );
  await assert.rejects(
    createArchitectApprovalHost({
      ...f.config,
      recipes: {
        ...f.config.recipes,
        'architect-approval': f.config.recipes['pr-review'],
      },
    }),
    /required host role/,
  );
  const bad = await createArchitectApprovalHost({
    ...f.config,
    request: createGitHubRequest({
      token: 'invalid',
      repository: f.config.repository,
      apiUrl: f.api.apiUrl,
    }),
  });
  await assert.rejects(bad.requestApproval(f.request), /401/);
  f.api.state.issue.body += '\n## Additional scope\nUnreviewed requirements.';
  await assert.rejects(
    f.host.requestApproval(f.request),
    /Current issue scope differs/,
  );
  assert.equal(
    (await readdir(f.config.storeRoot)).some((file) =>
      file.endsWith('.launch'),
    ),
    false,
  );
});

test('incomplete protection and protected or Foreman-owned changes stop before role launch', async (t) => {
  const f = await fixture(t);
  f.api.state.issue.labels = f.api.state.issue.labels
    .filter((label) => label.name !== 'worker:peon')
    .concat({ name: 'worker:foreman' });
  const denied = await f.host.requestApproval(f.request);
  assert.equal(denied.status, 'blocked');
  f.api.state.issue.labels = f.api.state.issue.labels
    .filter((label) => label.name !== 'worker:foreman')
    .concat({ name: 'worker:peon' });
  f.api.state.issue.body = f.api.state.issue.body.replace(
    '`widget.mjs`',
    '`tools/policy/gate.mjs`',
  );
  f.api.state.files[0].filename = 'tools/policy/gate.mjs';
  const protectedChange = await f.host.requestApproval(f.request);
  assert.equal(protectedChange.status, 'blocked');
  assert.ok(protectedChange.reasons.includes('protected-path-changed'));
  const unknown = await fixture(t, {
    onRequest: (route) =>
      route === '/branches/develop/protection' ? response(403) : undefined,
  });
  await assert.rejects(unknown.host.requestApproval(unknown.request), /403/);
  assert.deepEqual(await readdir(f.config.storeRoot), []);
});
