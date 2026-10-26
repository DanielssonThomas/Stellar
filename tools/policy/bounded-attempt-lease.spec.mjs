import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  reserveBoundedCodingAttempt,
  reserveMinimalCodingAttempt,
} from './bounded-attempt-lease.mjs';

test('admits one minimal run per issue revision across concurrent sessions', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stellar-minimal-attempt-'));
  try {
    const input = {
      repositoryRoot: path.join(root, 'repo'),
      issueNumber: 50,
      sessionId: 'session-a',
      branch: 'issue/50-avatar-shape',
      worktreePath: path.join(root, 'worktree'),
      revision: 'a'.repeat(40),
    };
    await mkdir(input.repositoryRoot);
    const results = await Promise.allSettled([
      Promise.resolve().then(() => reserveMinimalCodingAttempt(input)),
      Promise.resolve().then(() =>
        reserveMinimalCodingAttempt({ ...input, sessionId: 'session-b' }),
      ),
    ]);
    assert.equal(
      results.filter(({ status }) => status === 'fulfilled').length,
      1,
    );
    assert.equal(
      results.filter(({ status }) => status === 'rejected').length,
      1,
    );
    assert.match(
      results.find(({ status }) => status === 'rejected').reason.message,
      /already admitted/,
    );
    const first = results.find(({ status }) => status === 'fulfilled').value;
    const record = JSON.parse(await readFile(first.marker, 'utf8'));
    assert.equal(record.issueNumber, 50);
    assert.equal(record.revision, input.revision);
    assert.throws(() => reserveMinimalCodingAttempt(input), /already admitted/);
    assert.doesNotThrow(() =>
      reserveMinimalCodingAttempt({ ...input, revision: 'b'.repeat(40) }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('atomically consumes one supervisor session so relaunch cannot reset request capacity', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stellar-bounded-attempt-'));
  try {
    const options = {
      repositoryRoot: path.join(root, 'repo'),
      issueNumber: 50,
      sessionId: 'codex-test-session-a1',
      branch: 'issue/50-avatar-shape',
      worktreePath: path.join(root, 'issue-worktree'),
      revision: 'a'.repeat(40),
      requestLimit: 2,
    };
    await import('node:fs/promises').then(({ mkdir }) =>
      mkdir(options.repositoryRoot, { recursive: true }),
    );
    await import('node:fs/promises').then(({ mkdir }) =>
      mkdir(path.dirname(options.repositoryRoot), { recursive: true }),
    );
    const reserved = reserveBoundedCodingAttempt(options);
    assert.match(reserved.marker, /bounded-coding.*issue-50-/);
    assert.throws(
      () => reserveBoundedCodingAttempt(options),
      /already consumed/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects invalid request ceilings and incomplete attempt identity', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stellar-bounded-attempt-'));
  try {
    const input = {
      repositoryRoot: root,
      issueNumber: 50,
      sessionId: 'session',
      branch: 'issue/50-avatar-shape',
      worktreePath: path.join(root, 'worktree'),
      revision: 'a'.repeat(40),
      requestLimit: 3,
    };
    assert.throws(
      () => reserveBoundedCodingAttempt(input),
      /metadata is invalid/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reserves one issue-50 experiment only at four requests and 52,000 tokens', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stellar-four-request-'));
  try {
    const input = {
      repositoryRoot: root,
      issueNumber: 50,
      sessionId: `peon-issue-50-edit-first-four-${randomUUID()}`,
      branch: 'issue/50-avatar-shape',
      worktreePath: path.join(root, 'worktree'),
      revision: 'b'.repeat(40),
      requestLimit: 4,
      modelTokenLimit: 52_000,
    };
    const reservation = reserveBoundedCodingAttempt(input);
    assert.match(reservation.marker, /issue-50-/);
    assert.throws(() => reserveBoundedCodingAttempt(input), /already consumed/);
    assert.throws(
      () =>
        reserveBoundedCodingAttempt({
          ...input,
          sessionId: 'different',
          modelTokenLimit: 32_000,
        }),
      /metadata is invalid/,
    );
    assert.throws(
      () =>
        reserveBoundedCodingAttempt({
          ...input,
          sessionId: 'different',
          modelTokenLimit: undefined,
        }),
      /metadata is invalid/,
    );
    assert.throws(
      () =>
        reserveBoundedCodingAttempt({
          ...input,
          issueNumber: 51,
          sessionId: 'different',
        }),
      /metadata is invalid/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
