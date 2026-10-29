import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  advanceImmutableAttempt,
  newImmutableAttempt,
} from './immutable-attempt.mjs';
import {
  createImmutableAttemptJournal,
  inspectInterruptedAttemptJournal,
  readImmutableAttemptJournal,
  updateImmutableAttemptJournal,
} from './immutable-attempt-journal.mjs';

const identity = {
  issueNumber: 140,
  sessionId: 'trusted-session',
  revisionSha: 'a'.repeat(40),
  snapshotDigest: 'b'.repeat(64),
  executorAccount: 'stellar_exec',
  executorUid: 1100,
  executorGid: 1100,
  snapshotPath: '/var/lib/stellar-immutable/attempt-140',
  protectedPaths: ['AGENTS.md'],
  id: '22222222-2222-4222-8222-222222222222',
};

test('attempt journal persists CAS transitions and rejects stale updates', () => {
  const root = mkdtempSync(
    path.join(os.tmpdir(), 'stellar-immutable-journal-'),
  );
  try {
    const prepared = newImmutableAttempt(identity);
    const initial = createImmutableAttemptJournal(root, prepared);
    assert.equal(readImmutableAttemptJournal(root, prepared.id).revision, 0);
    const initialized = advanceImmutableAttempt(
      prepared,
      'volume-initialized',
      { volumeIdentity: '1:2' },
    );
    const next = updateImmutableAttemptJournal(
      root,
      initialized,
      initial.digest,
    );
    assert.equal(next.revision, 1);
    assert.equal(
      readImmutableAttemptJournal(root, prepared.id).record.status,
      'volume-initialized',
    );
    assert.throws(() =>
      updateImmutableAttemptJournal(root, initialized, initial.digest),
    );
    assert.throws(() =>
      updateImmutableAttemptJournal(
        root,
        { ...initialized, issueNumber: 999 },
        next.digest,
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('interrupted pending or lock file fails closed after process restart', () => {
  const root = mkdtempSync(
    path.join(os.tmpdir(), 'stellar-immutable-journal-'),
  );
  try {
    const prepared = newImmutableAttempt(identity);
    const { filename } = createImmutableAttemptJournal(root, prepared);
    writeFileSync(`${filename}.pending`, 'incomplete');
    assert.throws(
      () => readImmutableAttemptJournal(root, prepared.id),
      /quarantine/,
    );
    assert.deepEqual(inspectInterruptedAttemptJournal(root, prepared.id), {
      lockPresent: false,
      pendingPresent: true,
      safeToResume: false,
    });
    assert.ok(readFileSync(filename, 'utf8').includes('prepared'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
