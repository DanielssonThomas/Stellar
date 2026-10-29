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

test('reviewed lockfile and package inputs are required before any execution', async () => {
  assert.equal(
    validateReviewedDependencyInputs(candidate),
    'd58b1d779f62119bfc1d38a264a7ca1ca779488beff9f06d882cd0a1cc6ecee5',
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
    'd58b1d779f62119bfc1d38a264a7ca1ca779488beff9f06d882cd0a1cc6ecee5',
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
    'd58b1d779f62119bfc1d38a264a7ca1ca779488beff9f06d882cd0a1cc6ecee5',
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
