import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { defaultLimits } from '../supervise-worker.mjs';
import { loadIssue } from '../manage-issue-worktree.mjs';
import { createDependencyFixture } from '../issue-dependency-fixtures.mjs';
import { createEngineeringHost } from './host-engine.mjs';
import { inertRecipe } from './host-session.mjs';
import {
  assertRepositoryAdmission,
  createRepositoryAdmission,
  repositoryIssueDigest,
} from './host-context.mjs';
import { digest, MAX_PLANNING_BYTES } from './planning-evidence.mjs';

const now = '2026-11-01T12:00:00.000Z';
const sessionId = 'host-issue-42';
const request = { issueNumber: 42, sessionId };

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'stellar-admission-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repositoryRoot = join(root, 'repository');
  const worktree = join(root, 'worker');
  await mkdir(repositoryRoot);
  git(repositoryRoot, 'init', '-b', 'develop');
  await writeFile(join(repositoryRoot, 'widget.txt'), 'initial\n');
  git(repositoryRoot, 'add', 'widget.txt');
  git(
    repositoryRoot,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '-m',
    'fixture',
  );
  const revision = git(repositoryRoot, 'rev-parse', 'HEAD');
  git(
    repositoryRoot,
    'worktree',
    'add',
    '-b',
    'issue/42-small-widget',
    worktree,
  );
  const issue = {
    number: 42,
    title: 'Repair small widget',
    state: 'OPEN',
    body: '## Objective\nRepair widget.\n## Context\nWidget is broken.\n## Expected outcome\nWidget works.\n## Acceptance criteria\n- [ ] Widget renders.\n- [ ] Widget loads.\n## Constraints\nStay scoped.\n## Dependencies\nNone\n## Verification expectations\nRun unit tests.',
    labels: [
      'priority:low',
      'review:standard',
      'type:bug',
      'target:develop',
      'status:in-progress',
      'worker:peon',
    ],
    dependencies: [],
  };
  const claim = {
    issue: 42,
    state: 'active',
    worker: 'worker:peon',
    sessionId,
    target: 'develop',
    branch: 'issue/42-small-widget',
    worktreePath: worktree,
    expiresAt: '2026-11-01T13:00:00.000Z',
  };
  const claimPath = join(
    repositoryRoot,
    '.git',
    'stellar-agent',
    'claims',
    '42.json',
  );
  await mkdir(join(repositoryRoot, '.git', 'stellar-agent', 'claims'), {
    recursive: true,
  });
  await writeFile(claimPath, JSON.stringify(claim));
  const record = {
    schemaVersion: 1,
    repository: 'DanielssonThomas/Stellar',
    issueNumber: 42,
    sessionId,
    sourceRevision: revision,
    policyRevision: revision,
    issueDigest: repositoryIssueDigest(issue),
    scope: {
      complexity: 'small',
      ambiguous: false,
      riskFloor: 'standard',
      files: [{ filename: 'widget.txt', status: 'modified' }],
      requiredSkills: ['widget'],
      criteria: [
        { id: 'renders', description: 'Widget renders.' },
        { id: 'loads', description: 'Widget loads.' },
      ],
    },
    evidence: [
      {
        id: 'verified-attempt',
        worker: 'peon',
        skill: 'widget',
        outcome: 'passed',
        revision,
        artifact: 'host/verification.json',
        source: 'host-verified-attempt',
        completedAt: '2026-10-31T12:00:00.000Z',
      },
    ],
    authorizedWorkers: ['peon'],
    limits: { ...defaultLimits, maxAttemptsPerWorker: 1 },
  };
  const scopeRecordPath = join(root, 'scope.json');
  const save = () => writeFile(scopeRecordPath, JSON.stringify(record));
  await save();
  const options = () => ({
    repositoryRoot,
    scopeRecordPath,
    scopeRecordDigest: digest(record),
    hostReaders: {
      loadIssue: async () => issue,
      resolveDevelopHead: async () => revision,
      now: () => now,
    },
  });
  return {
    root,
    repositoryRoot,
    worktree,
    issue,
    claim,
    claimPath,
    record,
    scopeRecordPath,
    save,
    options,
    inspect: () => createRepositoryAdmission(options()).inspect(request),
  };
}

test('repository REST dependency provenance gates a real host before reservation or launch', async (t) => {
  const f = await fixture(t);
  const api = createDependencyFixture();
  api.state.issue = {
    ...f.issue,
    id: 1042,
    repository_url: api.repositoryUrl,
    state: 'open',
    body: f.issue.body.replace('Dependencies\nNone', 'Dependencies\n#23'),
  };
  const readIssue = () =>
    loadIssue(42, { repository: api.repository, runCommand: api.runCommand });
  Object.assign(f.issue, readIssue());
  f.record.issueDigest = repositoryIssueDigest(f.issue);
  await f.save();
  const options = f.options();
  options.hostReaders.loadIssue = readIssue;
  const admission = createRepositoryAdmission(options);
  assert.equal(
    (await admission.inspect(request)).facts.issue.dependencies[0].id,
    2023,
  );
  const storeRoot = join(f.root, 'host-journal');
  const poolRoot = join(f.root, 'host-pool');
  const recipes = Object.fromEntries(
    await Promise.all(
      ['dispatch', 'implement', 'verify', 'review', 'reconcile'].map(
        async (phase) => [phase, await inertRecipe(phase)],
      ),
    ),
  );
  const host = await createEngineeringHost({
    admission,
    storeRoot,
    poolRoot,
    recipes,
  });
  const claimBefore = await readFile(f.claimPath, 'utf8');
  api.state.native[0].repository_url =
    'https://api.github.com/repos/foreign/project';
  api.state.native[0].state = 'open';
  await assert.rejects(
    host.prepare({ ...request, key: 'foreign-dependency' }),
    /invalid identity/,
  );
  assert.deepEqual(await readdir(storeRoot), []);
  assert.deepEqual(await readdir(poolRoot), []);
  assert.equal(await readFile(f.claimPath, 'utf8'), claimBefore);
});

test('reads real claim and registered git worktree and returns stable detached admission facts', async (t) => {
  const f = await fixture(t);
  const admission = createRepositoryAdmission(f.options());
  assert.equal(assertRepositoryAdmission(admission), admission);
  assert.throws(
    () => assertRepositoryAdmission({ ...admission }),
    /host-created/,
  );
  assert.throws(
    () =>
      assertRepositoryAdmission({
        inspect: async () => ({ authenticated: true }),
      }),
    /host-created/,
  );
  const first = await admission.inspect(request);
  const second = await admission.inspect(request);
  assert.equal(first.digest, second.digest);
  assert.equal(first.digest, digest(first.facts));
  assert.equal(first.checkedAt, now);
  assert.equal(first.facts.capability.eligible, true);
  assert.deepEqual(first.facts.scope.allowedPaths, ['widget.txt']);
  first.facts.scope.allowedPaths.push('secret');
  first.facts.issue.labels.length = 0;
  assert.equal((await admission.inspect(request)).digest, second.digest);
  assert.equal(git(f.repositoryRoot, 'status', '--porcelain'), '');
  assert.equal(git(f.worktree, 'status', '--porcelain'), '');
});

test('rejects changed scope bytes even when the file self-claims a replacement digest', async (t) => {
  const f = await fixture(t);
  const admission = createRepositoryAdmission(f.options());
  f.record.scope.files[0].filename = 'other.txt';
  f.record.digest = digest(f.record);
  await f.save();
  await assert.rejects(admission.inspect(request), /trusted digest/);
});

test('rejects oversized, malformed and nonregular scope records', async (t) => {
  const f = await fixture(t);
  const admission = createRepositoryAdmission(f.options());
  await writeFile(
    f.scopeRecordPath,
    '界'.repeat(Math.ceil(MAX_PLANNING_BYTES / 3)),
  );
  await assert.rejects(admission.inspect(request), /byte bound/);
  await writeFile(f.scopeRecordPath, '{');
  await assert.rejects(admission.inspect(request), SyntaxError);
  await rm(f.scopeRecordPath);
  await mkdir(f.scopeRecordPath);
  await assert.rejects(admission.inspect(request), /regular/);
});

test('rejects hard-linked receipts and receipt paths inside worker worktrees', async (t) => {
  const f = await fixture(t);
  const other = join(f.root, 'linked.json');
  await link(f.scopeRecordPath, other);
  await assert.rejects(f.inspect(), /regular/);
  await rm(other);
  const workerReceipt = join(f.worktree, 'scope.json');
  await writeFile(workerReceipt, await readFile(f.scopeRecordPath));
  await assert.rejects(
    createRepositoryAdmission({
      ...f.options(),
      scopeRecordPath: workerReceipt,
    }).inspect(request),
    /outside the worker/,
  );
  const deceptiveDirectory = join(f.worktree, '..host');
  await mkdir(deceptiveDirectory);
  const deceptivePath = join(deceptiveDirectory, 'scope.json');
  await writeFile(deceptivePath, await readFile(f.scopeRecordPath));
  await assert.rejects(
    createRepositoryAdmission({
      ...f.options(),
      scopeRecordPath: deceptivePath,
    }).inspect(request),
    /outside the worker/,
  );
});

test(
  'rejects symbolic-link receipt paths',
  { skip: process.platform === 'win32' },
  async (t) => {
    const f = await fixture(t);
    const linked = join(f.root, 'symlink.json');
    await symlink(f.scopeRecordPath, linked);
    await assert.rejects(
      createRepositoryAdmission({
        ...f.options(),
        scopeRecordPath: linked,
      }).inspect(request),
      /symbolic links/,
    );
  },
);

test('requires passing host-verified capability receipts and conservative limits', async (t) => {
  const f = await fixture(t);
  for (const mutate of [
    () => {
      f.record.evidence = [];
    },
    () => {
      f.record.evidence = [
        {
          id: 'self',
          worker: 'peon',
          skill: 'widget',
          outcome: 'passed',
          revision: f.record.sourceRevision,
          artifact: 'report',
          source: 'agent-report',
          completedAt: now,
        },
      ];
    },
    () => {
      f.record.evidence[0].source = 'host-verified-attempt';
      f.record.evidence[0].outcome = 'failed';
    },
    () => {
      f.record.evidence[0].outcome = 'passed';
      f.record.limits.maxAttemptsPerWorker = 2;
    },
  ]) {
    mutate();
    await f.save();
    await assert.rejects(f.inspect(), /capability|host-verified|one-attempt/);
  }
});

test('rejects protected, ambiguous and incomplete acceptance scopes', async (t) => {
  const f = await fixture(t);
  f.record.scope.files[0].filename = 'tools/policy/test.mjs';
  await f.save();
  await assert.rejects(f.inspect(), /Sensitive/);
  f.record.scope.files[0].filename = 'widget.txt';
  f.record.scope.ambiguous = true;
  await f.save();
  await assert.rejects(f.inspect(), /ambiguous/);
  f.record.scope.ambiguous = false;
  f.record.scope.criteria.pop();
  await f.save();
  await assert.rejects(f.inspect(), /criteria do not match/);
});

test('rejects stale issue, source and policy bindings', async (t) => {
  const f = await fixture(t);
  for (const field of ['issueDigest', 'sourceRevision', 'policyRevision']) {
    const old = f.record[field];
    f.record[field] = 'a'.repeat(old.length);
    await f.save();
    await assert.rejects(f.inspect(), /stale/);
    f.record[field] = old;
  }
});

test('rejects changed, expired, foreign and unresolved assignment facts', async (t) => {
  const f = await fixture(t);
  for (const changes of [
    { issue: 43 },
    { sessionId: 'foreign' },
    { state: 'released' },
    { expiresAt: now },
    { branch: 'issue/42-foreign' },
  ]) {
    await writeFile(f.claimPath, JSON.stringify({ ...f.claim, ...changes }));
    await assert.rejects(f.inspect(), /claim|Claim|worktree/);
  }
  await writeFile(f.claimPath, JSON.stringify(f.claim));
  f.issue.dependencies = [
    { number: 41, state: 'OPEN', status: 'status:in-progress' },
  ];
  await assert.rejects(f.inspect(), /dependencies|metadata/);
});

test('rejects dirty or advanced registered worktrees', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.worktree, 'widget.txt'), 'changed\n');
  await assert.rejects(f.inspect(), /clean registered/);
  git(f.worktree, 'add', 'widget.txt');
  git(
    f.worktree,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '-m',
    'changed',
  );
  await assert.rejects(f.inspect(), /clean registered/);
});

test('rejects authority changes during a two-pass read and at the final expiry check', async (t) => {
  const f = await fixture(t);
  const options = f.options();
  let reads = 0;
  options.hostReaders.loadIssue = async () => {
    if (++reads === 2) f.issue.title = 'Reassigned scope';
    return f.issue;
  };
  await assert.rejects(
    createRepositoryAdmission(options).inspect(request),
    /stale/,
  );
  f.issue.title = 'Repair small widget';
  reads = 0;
  options.hostReaders.loadIssue = async () => {
    if (++reads === 2)
      await writeFile(
        f.claimPath,
        JSON.stringify({ ...f.claim, expiresAt: '2026-11-01T14:00:00.000Z' }),
      );
    return f.issue;
  };
  await assert.rejects(
    createRepositoryAdmission(options).inspect(request),
    /authority changed during/,
  );
  await writeFile(f.claimPath, JSON.stringify(f.claim));
  let ticks = 0;
  const expiry = f.options();
  expiry.hostReaders.now = () => (++ticks === 3 ? f.claim.expiresAt : now);
  await assert.rejects(
    createRepositoryAdmission(expiry).inspect(request),
    /expired during/,
  );
});

test('rejects malformed identity and forged production reader options before admission', async (t) => {
  const f = await fixture(t);
  const admission = createRepositoryAdmission(f.options());
  await assert.rejects(
    admission.inspect({ issueNumber: '42', sessionId }),
    /positive issue/,
  );
  await assert.rejects(
    admission.inspect({ ...request, sessionId: [sessionId] }),
    /stable supervisor/,
  );
  assert.throws(
    () =>
      createRepositoryAdmission({
        ...f.options(),
        scopeRecordDigest: ['a'.repeat(64)],
      }),
    /host-retained/,
  );
  assert.throws(
    () =>
      createRepositoryAdmission({
        ...f.options(),
        hostReaders: { admitted: () => true },
      }),
    /read-only/,
  );
});
