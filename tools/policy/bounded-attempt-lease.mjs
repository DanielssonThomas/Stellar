import { createHash } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export function reserveBoundedCodingAttempt({
  repositoryRoot,
  issueNumber,
  sessionId,
  branch,
  worktreePath,
  revision,
  requestLimit,
}) {
  if (
    !path.isAbsolute(repositoryRoot ?? '') ||
    !Number.isSafeInteger(issueNumber) ||
    issueNumber < 1 ||
    typeof sessionId !== 'string' ||
    !sessionId ||
    !/^issue\/[1-9][0-9]*-[a-z0-9-]+$/.test(branch ?? '') ||
    !path.isAbsolute(worktreePath ?? '') ||
    !/^[a-f0-9]{40,64}$/.test(revision ?? '') ||
    requestLimit !== 2
  )
    throw new Error('Bounded attempt reservation metadata is invalid.');

  const stateRoot = path.resolve(
    repositoryRoot,
    '..',
    '.stellar-supervisor-state',
  );
  const boundedRoot = path.join(stateRoot, 'bounded-coding');
  const canonicalStateParent = realpathSync(path.dirname(stateRoot));
  if (canonicalStateParent !== path.dirname(stateRoot))
    throw new Error('Bounded attempt state parent resolves through a symlink.');
  mkdirSync(boundedRoot, { recursive: true, mode: 0o700 });
  if (realpathSync(boundedRoot) !== boundedRoot)
    throw new Error(
      'Bounded attempt state directory resolves through a symlink.',
    );
  const sessionHash = createHash('sha256').update(sessionId).digest('hex');
  const marker = path.join(
    boundedRoot,
    `issue-${issueNumber}-${sessionHash}.json`,
  );
  const relative = path.relative(worktreePath, marker);
  if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative)))
    throw new Error(
      'Bounded attempt state must remain outside the issue worktree.',
    );
  const record = {
    schema: 'stellar.bounded-attempt-reservation/v1',
    issueNumber,
    sessionHash,
    branch,
    worktreePath,
    revision,
    maxForwardedRequests: requestLimit,
    reservedAt: new Date().toISOString(),
    outcome: 'reserved',
  };
  let descriptor;
  try {
    descriptor = openSync(marker, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify(record)}\n`, 'utf8');
  } catch (error) {
    if (error?.code === 'EEXIST')
      throw new Error(
        'This bounded-coding supervisor session was already consumed.',
      );
    throw new Error('Could not persist bounded-coding attempt reservation.');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  return { marker, sessionHash };
}
