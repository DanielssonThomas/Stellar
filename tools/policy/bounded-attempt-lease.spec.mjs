import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { reserveBoundedCodingAttempt } from './bounded-attempt-lease.mjs';

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
