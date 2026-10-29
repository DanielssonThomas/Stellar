import assert from 'node:assert/strict';
import test from 'node:test';
import {
  advanceImmutableAttempt,
  buildPrivateWorkspaceMounts,
  immutableAttemptFingerprint,
  newImmutableAttempt,
  rejectImmutablePublication,
} from './immutable-attempt.mjs';

const identity = {
  issueNumber: 140,
  sessionId: 'trusted-session',
  revisionSha: 'a'.repeat(40),
  snapshotDigest: 'b'.repeat(64),
  executorAccount: 'stellar_exec',
  executorUid: 1100,
  executorGid: 1100,
  snapshotPath: '/var/lib/stellar-immutable/attempt-140',
  protectedPaths: ['AGENTS.md', 'docs/guides/issue-workflow.md'],
  id: '11111111-1111-4111-8111-111111111111',
};

test('private mounts bind only sealed source and attempt volume', () => {
  const prepared = newImmutableAttempt(identity);
  const initialized = advanceImmutableAttempt(prepared, 'volume-initialized');
  const mounts = buildPrivateWorkspaceMounts(initialized);
  assert.equal(mounts.length, 4);
  assert.ok(mounts.every((item) => !item.includes('/home/peon/workspaces')));
  assert.ok(
    mounts.some(
      (item) =>
        item.endsWith('dst=/workspace') &&
        item.includes(initialized.volumeName),
    ),
  );
  assert.ok(
    mounts
      .filter((item) => item.includes('dst=/workspace/'))
      .every((item) => item.endsWith(',ro')),
  );
  assert.throws(() => buildPrivateWorkspaceMounts(initialized, 'other-volume'));
  assert.throws(() => buildPrivateWorkspaceMounts(prepared));
});

test('attempt identity rejects Peon, traversal, malformed source and duplicate transitions', () => {
  for (const override of [
    { executorAccount: 'peon' },
    { executorUid: 1001 },
    { snapshotPath: '/home/peon/workspaces/issue-140' },
    { protectedPaths: ['../secrets'] },
    { protectedPaths: ['.git/config'] },
    { snapshotDigest: 'bad' },
  ])
    assert.throws(() => newImmutableAttempt({ ...identity, ...override }));
  const prepared = newImmutableAttempt(identity);
  assert.throws(() => advanceImmutableAttempt(prepared, 'running'));
  assert.throws(() =>
    advanceImmutableAttempt(prepared, 'collected', {
      candidateDigest: 'c'.repeat(64),
    }),
  );
  assert.equal(immutableAttemptFingerprint(prepared).length, 64);
});

test('collection requires digest and failure remains quarantined without publication', () => {
  let record = newImmutableAttempt(identity);
  for (const state of ['volume-initialized', 'running', 'stopped'])
    record = advanceImmutableAttempt(record, state);
  assert.throws(() => advanceImmutableAttempt(record, 'collected'));
  record = advanceImmutableAttempt(record, 'collected', {
    candidateDigest: 'c'.repeat(64),
  });
  record = advanceImmutableAttempt(record, 'verified');
  assert.throws(rejectImmutablePublication, /disabled/);
  record = advanceImmutableAttempt(record, 'quarantined');
  assert.equal(advanceImmutableAttempt(record, 'cleaned').status, 'cleaned');
  assert.throws(() => advanceImmutableAttempt(record, 'running'));
});
