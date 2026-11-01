import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  buildCandidateTestArgs,
  classifyOfflineDependencyFailure,
  runPrivateCandidateChecks,
  sanitizeTestDiagnostic,
  validateReviewedDependencyInputs,
} from './private-candidate-tests.mjs';
import { trustedPeonWorkerImage } from './supervised-peon-run.mjs';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const digest = (name) =>
  createHash('sha256')
    .update(readFileSync(path.join(root, name)))
    .digest('hex');
const candidate = {
  attemptId: 'issue-149-attempt-1',
  privatePath: '/home/peon/candidates/issue-149-attempt-1',
  contentDigest: 'a'.repeat(64),
  files: ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'].map(
    (name) => ({ path: name, sha256: digest(name) }),
  ),
};
const options = {
  issueNumber: 149,
  attemptNumber: 1,
  privateRoot: '/home/peon/private',
  candidateRoot: '/home/peon/candidates',
  testRoot: '/home/peon/tests',
  trustedProtectedRoot: '/home/peon/protected',
  protectedPaths: ['AGENTS.md'],
  uid: 1001,
  gid: 1001,
  cacheRoot: `/home/peon/stellar-dependency-cache/${digest('pnpm-lock.yaml')}`,
  checkNames: ['nx-project-discovery'],
};
const workspace = '/home/peon/tests/issue-149-attempt-1/workspace';

test('named checks retain the restricted image, resources, network and attempt-local mounts', () => {
  const args = buildCandidateTestArgs(options, candidate, workspace, [
    'pnpm',
    'exec',
    'nx',
    'show',
    'projects',
    '--json',
  ]);
  for (const flag of [
    '--pull=never',
    '--network=none',
    '--read-only',
    '--cap-drop=all',
    '--security-opt=no-new-privileges',
    '--memory=4g',
    '--pids-limit=128',
    trustedPeonWorkerImage,
  ])
    assert.ok(args.includes(flag), flag);
  assert.ok(
    args.includes(`--mount=type=bind,src=${workspace},dst=/workspace,rw`),
  );
  assert.ok(
    args.includes(
      '--mount=type=bind,src=/home/peon/tests/issue-149-attempt-1/store,dst=/store,rw',
    ),
  );
  assert.ok(
    args.includes(
      '--mount=type=bind,src=/home/peon/protected/AGENTS.md,dst=/workspace/AGENTS.md,ro',
    ),
  );
  assert.ok(args.every((arg) => !arg.includes('src=/home/peon/workspaces/')));
  assert.ok(args.every((arg) => !arg.includes('stellar-dependency-cache')));
});

test('exact-source checks mount disposable Git, dependencies and store read-only', () => {
  const strict = { ...options, requireExactTestSource: true };
  const args = buildCandidateTestArgs(strict, candidate, workspace, [
    'pnpm',
    'exec',
    'nx',
    'show',
    'projects',
    '--json',
  ]);
  for (const mount of [
    `--mount=type=bind,src=${workspace}/node_modules,dst=/workspace/node_modules,ro`,
    `--mount=type=bind,src=${workspace}/.git,dst=/workspace/.git,ro`,
    '--mount=type=bind,src=/home/peon/tests/issue-149-attempt-1/store,dst=/store,ro',
  ])
    assert.ok(args.includes(mount), mount);
  const install = buildCandidateTestArgs(strict, candidate, workspace, [
    'pnpm',
    'install',
    '--offline',
    '--frozen-lockfile',
    '--ignore-scripts',
    '--package-import-method=copy',
    '--store-dir',
    '/store',
  ]);
  assert.ok(install.some((entry) => entry.endsWith('dst=/store,rw')));
  assert.ok(
    install.every((entry) => !entry.includes('dst=/workspace/.git,ro')),
  );
});

test('molecule checks accept only the reviewed fixed commands', () => {
  const commands = [
    ['pnpm', 'exec', 'nx', 'show', 'project', 'ui-molecules', '--json'],
    ['pnpm', 'exec', 'nx', 'run', 'ui-molecules:lint'],
    [
      'pnpm',
      'exec',
      'node',
      'tools/policy/run-ui-molecules-tests.mjs',
      '--require-agent-status',
    ],
    ['pnpm', 'exec', 'nx', 'run', 'ui-molecules:build'],
  ];
  for (const command of commands) {
    const args = buildCandidateTestArgs(options, candidate, workspace, command);
    assert.ok(args.includes('--entrypoint=corepack'));
    assert.deepEqual(args.slice(-command.length), command);
  }
  for (const command of [
    ['pnpm', 'exec', 'nx', 'run', 'ui-molecules:unit-test'],
    ['node', 'tools/policy/run-ui-molecules-tests.mjs'],
    ['node', 'tools/policy/run-ui-molecules-tests.mjs', '--skip-tests'],
    ['pnpm', 'exec', 'node', 'tools/policy/run-ui-molecules-tests.mjs'],
  ])
    assert.throws(
      () => buildCandidateTestArgs(options, candidate, workspace, command),
      /named command/,
    );
});

test('unreviewed commands, substituted workspaces and stale attempt paths fail closed', () => {
  for (const command of [
    ['pnpm', 'run', 'arbitrary'],
    ['pnpm', 'exec', 'nx', 'run', 'other:build'],
    ['pnpm', 'install', '--offline', '--frozen-lockfile'],
    ['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts'],
    ['/bin/sh', '-c', 'true'],
  ])
    assert.throws(
      () => buildCandidateTestArgs(options, candidate, workspace, command),
      /named command/,
    );
  assert.throws(
    () =>
      buildCandidateTestArgs(
        options,
        candidate,
        '/home/peon/workspaces/issue-149',
        ['pnpm', 'exec', 'nx', 'show', 'projects', '--json'],
      ),
    /mount/,
  );
  assert.throws(
    () =>
      buildCandidateTestArgs(
        options,
        candidate,
        '/home/peon/tests/issue-149-attempt-2/workspace',
        ['pnpm', 'exec', 'nx', 'show', 'projects', '--json'],
      ),
    /mount/,
  );
});

test('direct argument builder rejects a writable candidate or protected root mount', () => {
  const command = ['pnpm', 'exec', 'nx', 'show', 'projects', '--json'];
  const completeCandidate = {
    ...candidate,
    privatePath: '/home/peon/candidates/issue-149-attempt-1',
  };
  for (const testRoot of [
    options.candidateRoot,
    options.privateRoot,
    options.trustedProtectedRoot,
    options.cacheRoot,
    '/home/peon/workspaces',
    completeCandidate.privatePath,
  ])
    assert.throws(
      () =>
        buildCandidateTestArgs(
          { ...options, testRoot },
          completeCandidate,
          `${testRoot}/${candidate.attemptId}/workspace`,
          command,
        ),
      /Exact disposable test mount/,
    );
});

test('container execution helper is not a public bypass around candidate validation', async () => {
  const module = await import('./private-candidate-tests.mjs');
  assert.equal(Object.hasOwn(module, 'runNamedCandidateCheck'), false);
  assert.equal(Object.hasOwn(module, 'prepareDisposableGit'), false);
});

test('offline metadata, missing contents, lock mismatch and uncertain install remain distinct failures', () => {
  const result = (diagnostic, overrides = {}) => ({
    exitCode: 1,
    diagnostic,
    error: null,
    timedOut: false,
    cancelled: false,
    ...overrides,
  });
  assert.equal(
    classifyOfflineDependencyFailure(result('ERR_PNPM_NO_OFFLINE_META')),
    'missing-offline-metadata',
  );
  assert.equal(
    classifyOfflineDependencyFailure(result('ERR_PNPM_NO_OFFLINE_TARBALL')),
    'missing-offline-content',
  );
  assert.equal(
    classifyOfflineDependencyFailure(result('ERR_PNPM_OUTDATED_LOCKFILE')),
    'lockfile-mismatch',
  );
  assert.equal(
    classifyOfflineDependencyFailure(result('other failure')),
    'install-failed',
  );
  assert.equal(
    classifyOfflineDependencyFailure(result('', { timedOut: true })),
    'inconclusive',
  );
  assert.equal(
    classifyOfflineDependencyFailure(result('', { cancelled: true })),
    'inconclusive',
  );
  assert.equal(
    classifyOfflineDependencyFailure(
      result('', { exitCode: null, signal: 'SIGKILL' }),
    ),
    'inconclusive',
  );
  assert.equal(
    classifyOfflineDependencyFailure(result('', { exitCode: 0 })),
    null,
  );
});

test('unreviewed package scripts remain rejected in both checkout byte forms', async () => {
  const manifest = JSON.parse(
    readFileSync(path.join(root, 'package.json'), 'utf8'),
  );
  manifest.scripts['policy:test'] = 'node unreviewed-policy-runner.mjs';
  const lf = `${JSON.stringify(manifest, null, 2)}\n`;
  for (const text of [lf, lf.replaceAll('\n', '\r\n')]) {
    const changed = {
      ...candidate,
      files: candidate.files.map((entry) =>
        entry.path === 'package.json'
          ? {
              ...entry,
              sha256: createHash('sha256').update(text).digest('hex'),
            }
          : entry,
      ),
    };
    assert.throws(
      () => validateReviewedDependencyInputs(changed),
      /package.json differs/,
    );
    await assert.rejects(
      runPrivateCandidateChecks(options, changed),
      /package.json differs/,
    );
  }
});

test('reviewed lockfile and package inputs are required before any execution', async () => {
  assert.equal(
    validateReviewedDependencyInputs(candidate),
    'f210bc60c2bb888c15c01f9f85c35706b841c5dbccc726ca56dc9d133ab927b0',
  );
  const lfCandidate = {
    ...candidate,
    files: candidate.files.map((entry) => ({
      ...entry,
      sha256: createHash('sha256')
        .update(
          readFileSync(path.join(root, entry.path), 'utf8').replaceAll(
            '\r\n',
            '\n',
          ),
        )
        .digest('hex'),
    })),
  };
  assert.equal(
    validateReviewedDependencyInputs(lfCandidate),
    'f210bc60c2bb888c15c01f9f85c35706b841c5dbccc726ca56dc9d133ab927b0',
  );
  const crlfCandidate = {
    ...candidate,
    files: candidate.files.map((entry) => ({
      ...entry,
      sha256: createHash('sha256')
        .update(
          readFileSync(path.join(root, entry.path), 'utf8')
            .replaceAll('\r\n', '\n')
            .replaceAll('\n', '\r\n'),
        )
        .digest('hex'),
    })),
  };
  assert.equal(
    validateReviewedDependencyInputs(crlfCandidate),
    'f210bc60c2bb888c15c01f9f85c35706b841c5dbccc726ca56dc9d133ab927b0',
  );
  await assert.rejects(
    runPrivateCandidateChecks(options, {
      ...candidate,
      files: candidate.files.map((entry) =>
        entry.path === 'pnpm-lock.yaml'
          ? { ...entry, sha256: 'b'.repeat(64) }
          : entry,
      ),
    }),
    /pnpm-lock.yaml differs/,
  );
  await assert.rejects(
    runPrivateCandidateChecks(options, {
      ...candidate,
      files: [
        ...candidate.files,
        { path: '.pnpmfile.cjs', sha256: 'c'.repeat(64) },
      ],
    }),
    /hooks or configuration/,
  );
  await assert.rejects(
    runPrivateCandidateChecks(
      { ...options, checkNames: ['worker-supplied-command'] },
      candidate,
    ),
    /named checks/,
  );
  for (const testRoot of [
    options.candidateRoot,
    options.privateRoot,
    options.trustedProtectedRoot,
    options.cacheRoot,
    candidate.privatePath,
  ])
    await assert.rejects(
      runPrivateCandidateChecks({ ...options, testRoot }, candidate),
      /named checks/,
    );
  await assert.rejects(
    runPrivateCandidateChecks(
      { ...options, signal: AbortSignal.abort() },
      candidate,
    ),
    /named checks/,
  );
});

test('stored diagnostics are redacted and bounded after redaction, including Unicode', () => {
  const secret = `token=${'x'.repeat(60)}`;
  const output = `${secret} ${'🌟'.repeat(2000)}`;
  const sanitized = sanitizeTestDiagnostic(output);
  assert.ok(Buffer.byteLength(sanitized, 'utf8') <= 4096);
  assert.ok(!sanitized.includes(secret));
  assert.equal(
    sanitizeTestDiagnostic(`Bearer ${'a'.repeat(30)}`),
    'Bearer [REDACTED]',
  );
});
