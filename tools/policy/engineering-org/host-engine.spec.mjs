import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createHostFixture } from './host-fixtures.mjs';
import { createEngineeringHost } from './host-engine.mjs';
import { createRepositoryAdmission } from './host-context.mjs';
import { openHostStore } from './host-store.mjs';
import { digest } from './planning-evidence.mjs';
import { registerHostRecipe } from './host-session.mjs';

async function fixture(t) {
  const value = await createHostFixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  return value;
}

test('real inert sessions complete once, with separate review/reconciliation and immutable replay', async (t) => {
  const f = await fixture(t);
  const result = await f.host.run(f.request);
  assert.equal(result.value.status, 'ready-for-integration-review');
  const id = result.value.grantId;
  const store = await openHostStore(f.hostOptions.storeRoot);
  const sessions = await Promise.all(
    ['dispatch', 'implement', 'verify', 'review', 'reconcile'].map((phase) =>
      store.read(`${id}.${phase}.result`),
    ),
  );
  assert.equal(
    new Set(sessions.map((session) => session.value.receipt.nonce)).size,
    5,
  );
  assert.deepEqual(
    sessions.map((session) => session.value.receipt.role),
    ['foreman', 'peon', 'verifier', 'foreman', 'foreman'],
  );
  assert.ok(sessions.every((session) => session.value.receipt.terminated));
  const originalFiles = (await readdir(f.hostOptions.storeRoot)).sort();
  assert.deepEqual(await f.host.run(f.request), result);
  assert.deepEqual(
    (await readdir(f.hostOptions.storeRoot)).sort(),
    originalFiles,
  );
  await assert.rejects(
    f.host.prepare({ ...f.request, key: 'new-key' }),
    /already consumed/,
  );
  assert.equal(
    await readFile(path.join(f.worktree, 'widget.mjs'), 'utf8'),
    'export const value = 1;\n',
  );
  assert.equal((await f.host.recover()).status, 'idle');
  const entryPoint = path.join(f.root, 'changed-recipe.mjs');
  const script = `${await readFile(f.hostOptions.recipes.dispatch.entryPoint, 'utf8')}\n`;
  await writeFile(entryPoint, script);
  const dispatch = await registerHostRecipe({
    phase: 'dispatch',
    role: 'foreman',
    mode: 'inert',
    entryPoint,
    expectedDigest: createHash('sha256').update(script).digest('hex'),
  });
  const changedHost = await createEngineeringHost({
    ...f.hostOptions,
    recipes: { ...f.hostOptions.recipes, dispatch },
  });
  await assert.rejects(changedHost.prepare(f.request), /already consumed/);
  for (const operation of ['execute', 'review', 'reconcile'])
    await assert.rejects(changedHost[operation](id), /Grant identity/);
  const review = await store.read(`${id}.review`);
  review.value.attemptDigest = 'f'.repeat(64);
  await writeFile(
    path.join(store.root, `${id}.review`),
    JSON.stringify({ value: review.value, digest: digest(review.value) }),
  );
  await assert.rejects(
    f.host.reconcile(id),
    /matching persisted independent review/,
  );
});

for (const fault of ['defect', 'provider-failure', 'hang']) {
  test(`every stopped ${fault} attempt receives a fresh blocked/correction review`, async (t) => {
    const f = await fixture(t);
    const host = await createEngineeringHost({
      ...f.hostOptions,
      faults: { implement: fault },
      timeoutMs: 2000,
    });
    const result = await host.run(f.request);
    assert.equal(result.value.status, 'blocked');
    const store = await openHostStore(f.hostOptions.storeRoot);
    const review = (await store.read(`${result.value.grantId}.review`)).value;
    assert.equal(
      review.decision,
      fault === 'defect' ? 'corrections-required' : 'blocked',
    );
    assert.equal(
      review.report.kind,
      fault === 'defect' ? undefined : 'attempt-failure',
    );
    assert.equal((await host.recover()).status, 'idle');
  });
}

test('role impersonation and forged admission cannot start a host session', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    createEngineeringHost({
      ...f.hostOptions,
      admission: { inspect: async () => ({ authenticated: true }) },
    }),
    /host-created/,
  );
  await assert.rejects(
    createEngineeringHost({
      ...f.hostOptions,
      recipes: {
        ...f.hostOptions.recipes,
        dispatch: f.hostOptions.recipes.implement,
      },
    }),
    /required host role/,
  );
  await assert.rejects(
    f.host.prepare({ ...f.request, caller: 'foreman' }),
    /only issue/,
  );
  assert.deepEqual(await readdir(f.hostOptions.storeRoot), []);
  const pool = await openHostStore(f.hostOptions.poolRoot);
  await pool.create('active', { unknown: 'owner' });
  await assert.rejects(
    f.host.prepare(f.request),
    /Invalid shared-slot evidence/,
  );
  assert.equal(
    (await readdir(f.hostOptions.storeRoot)).some(
      (name) => name.endsWith('.launch') || name.endsWith('.reservation'),
    ),
    false,
  );
});

test('fresh issue authority blocks launch and stale result review', async (t) => {
  const f = await fixture(t);
  const grant = await f.host.prepare(f.request);
  f.issue.labels = f.issue.labels
    .filter((label) => label !== 'worker:peon')
    .concat('worker:mira');
  await assert.rejects(f.host.execute(grant.id));
  assert.equal(
    (await readdir(f.hostOptions.storeRoot)).some((name) =>
      name.includes('.implement.'),
    ),
    false,
  );
});

test('late claim reassignment prevents accepting child output and leaves no review', async (t) => {
  const f = await fixture(t);
  let reads = 0;
  const admission = createRepositoryAdmission({
    ...f.options,
    hostReaders: {
      ...f.options.hostReaders,
      loadIssue: async () => {
        reads += 1;
        if (reads === 9)
          f.issue.labels = f.issue.labels
            .filter((label) => label !== 'worker:peon')
            .concat('worker:mira');
        return f.issue;
      },
    },
  });
  const host = await createEngineeringHost({ ...f.hostOptions, admission });
  await assert.rejects(host.prepare(f.request), /quarantined/);
  const names = await readdir(f.hostOptions.storeRoot);
  const record = JSON.parse(
    await readFile(
      path.join(
        f.hostOptions.storeRoot,
        names.find((name) => name.endsWith('.dispatch.result')),
      ),
      'utf8',
    ),
  );
  assert.equal(record.value.authorityCurrent, false);
  assert.equal(record.value.receipt.terminated, true);
  assert.equal((await host.recover()).status, 'idle');
});

test('candidate bytes and commit substitution invalidate review before another child starts', async (t) => {
  const f = await fixture(t);
  const grant = await f.host.prepare(f.request);
  const attempt = await f.host.execute(grant.id);
  await assert.rejects(f.host.reconcile(grant.id), { code: 'ENOENT' });
  await writeFile(
    path.join(
      f.hostOptions.storeRoot,
      `${grant.id}.candidate-tree`,
      'widget.mjs',
    ),
    'export const value = 999;\n',
  );
  await assert.rejects(f.host.review(grant.id), /bytes no longer/);
  assert.equal(
    (await readdir(f.hostOptions.storeRoot)).some((name) =>
      name.includes('.review.'),
    ),
    false,
  );
  assert.equal(
    digest(attempt.value.candidate.files),
    attempt.value.candidate.contentDigest,
  );
  await writeFile(
    path.join(
      f.hostOptions.storeRoot,
      `${grant.id}.candidate-tree`,
      'widget.mjs',
    ),
    attempt.value.candidate.files[0].content,
  );
  const originalContentDigest = attempt.value.candidate.contentDigest;
  attempt.value.candidate.gitCommit = attempt.value.candidate.sourceRevision;
  assert.equal(attempt.value.candidate.contentDigest, originalContentDigest);
  await writeFile(
    path.join(f.hostOptions.storeRoot, `${grant.id}.attempt.result`),
    JSON.stringify({ value: attempt.value, digest: digest(attempt.value) }),
  );
  await assert.rejects(f.host.review(grant.id), /integrity mismatch/);
});
