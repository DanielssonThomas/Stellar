import { execFileSync } from 'node:child_process';
import {
  closeSync,
  fstatSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';
import { identifier } from './values.mjs';

export const observationWindowMs = 48 * 60 * 60 * 1000;
export const maxSessions = 40;

export function isoAt(milliseconds) {
  return Number.isFinite(milliseconds) &&
    milliseconds > 0 &&
    milliseconds <= 8_640_000_000_000_000
    ? new Date(milliseconds).toISOString()
    : undefined;
}

export function pathKey(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return '';
  const normalized = path.resolve(value).replaceAll('\\', '/');
  if (process.platform !== 'win32') return normalized;
  const windowsPath = normalized.toLowerCase();
  if (windowsPath.startsWith('//?/unc/')) return `//${windowsPath.slice(8)}`;
  if (windowsPath.startsWith('//?/')) return windowsPath.slice(4);
  return windowsPath;
}

export function containsPath(root, value) {
  return Boolean(root && (value === root || value.startsWith(`${root}/`)));
}

export function sourceLabel(value) {
  try {
    return identifier(value, 'source label', true) ?? undefined;
  } catch {
    return undefined;
  }
}

function originKey(value) {
  return typeof value === 'string'
    ? value
        .trim()
        .replace(/^git@([^:]+):/, '$1/')
        .replace(/^https?:\/\//, '')
        .replace(/\.git$/i, '')
        .toLowerCase()
    : '';
}

function git(repository, ...args) {
  return execFileSync('git', ['-C', repository, ...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024,
    timeout: 1000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

export function readBounded(file, limit, tail = false) {
  const descriptor = openSync(file, 'r');
  try {
    const { size } = fstatSync(descriptor);
    if (!tail && size > limit) return null;
    const offset = Math.max(0, size - limit);
    const buffer = Buffer.alloc(size - offset);
    const bytes = readSync(descriptor, buffer, 0, buffer.length, offset);
    const text = buffer.toString('utf8', 0, bytes);
    // The beginning of a tail may be in the middle of an unrelated record.
    if (!offset) return text;
    const firstLineBreak = text.indexOf('\n');
    return firstLineBreak === -1 ? '' : text.slice(firstLineBreak + 1);
  } finally {
    closeSync(descriptor);
  }
}

export function readClaims(repository) {
  const gitDir = realpathSync(
    path.resolve(
      repository,
      git(repository, 'rev-parse', '--git-common-dir').trim(),
    ),
  );
  const origin = originKey(
    git(repository, 'config', '--get', 'remote.origin.url'),
  );
  if (!origin) return { claims: [], budgets: [] };

  const worktrees = git(repository, 'worktree', 'list', '--porcelain', '-z');
  const claims = [];
  const budgets = new Map();
  let registry;
  try {
    registry = sourceFile(gitDir, 'stellar-agent/claims');
  } catch {
    return { claims: [], budgets: [] };
  }
  const readClaim = (name) =>
    JSON.parse(readBounded(sourceFile(registry, name), 64 * 1024));
  const rememberBudget = (claim) => {
    if (!Array.isArray(claim.budgetRevisions) || !claim.budgetRevisions.length)
      return;
    budgets.set(claim.issue, {
      issue: claim.issue,
      revisions: claim.budgetRevisions,
      complexity: claim.complexity,
    });
  };
  for (const worktree of worktrees.split('\0\0')) {
    const fields = worktree.split('\0');
    const branch = fields
      .find((field) => field.startsWith('branch refs/heads/'))
      ?.slice(18);
    const issue = Number(/^issue\/(\d+)(?:-|$)/.exec(branch ?? '')?.[1]);
    const directory = fields
      .find((field) => field.startsWith('worktree '))
      ?.slice(9);
    if (!Number.isSafeInteger(issue) || issue <= 0 || !directory) continue;
    try {
      const claim = readClaim(`${issue}.json`);
      const start = Date.parse(claim?.createdAt);
      const expiry = Date.parse(claim?.expiresAt);
      const stop =
        claim?.state === 'active'
          ? expiry
          : Math.min(expiry, Date.parse(claim?.releasedAt));
      const worktreePath = pathKey(directory);
      if (
        claim?.issue === issue &&
        claim.branch === branch &&
        ['active', 'released'].includes(claim.state) &&
        pathKey(claim.worktreePath) === worktreePath &&
        Number.isFinite(start) &&
        Number.isFinite(stop) &&
        stop >= start
      ) {
        claims.push({ issue, branch, worktreePath, origin, start, stop });
        rememberBudget(claim);
      }
    } catch {
      // An unreadable or concurrently replaced claim is not attribution evidence.
    }
  }
  // Released claims in this repository's common Git directory can preserve budget
  // history even after their worktrees are removed. They cannot attribute sessions.
  let directory;
  try {
    directory = opendirSync(registry);
    for (let index = 0; index < 512; index++) {
      const entry = directory.readSync();
      if (!entry) break;
      const issue = Number(/^(\d+)\.json$/.exec(entry.name)?.[1]);
      if (
        !entry.isFile() ||
        !Number.isSafeInteger(issue) ||
        issue <= 0 ||
        budgets.has(issue)
      )
        continue;
      try {
        const claim = readClaim(entry.name);
        if (
          claim?.issue === issue &&
          claim.state === 'released' &&
          new RegExp(`^issue/${issue}(?:-|$)`).test(claim.branch) &&
          Number.isFinite(Date.parse(claim.releasedAt))
        ) {
          rememberBudget(claim);
        }
      } catch {
        // A concurrently replaced or unrecognized history record contributes no budget.
      }
    }
  } catch {
    // A repository can have no claim registry yet.
  } finally {
    directory?.closeSync();
  }
  return {
    claims: claims
      .sort((first, second) => second.stop - first.stop)
      .slice(0, 128),
    budgets: [...budgets.values()],
  };
}

export function findClaim(claims, { cwd, branch, origin, repoRoot, started }) {
  const workDirectory = pathKey(cwd);
  const root = pathKey(repoRoot);
  const remote = originKey(origin);
  if (!workDirectory || !Number.isFinite(started)) return undefined;
  return claims.find(
    (claim) =>
      containsPath(claim.worktreePath, workDirectory) &&
      (repoRoot == null || root === claim.worktreePath) &&
      (branch == null || branch === claim.branch) &&
      (origin == null || remote === claim.origin) &&
      started >= claim.start &&
      started <= claim.stop,
  );
}

export function sourceFile(root, relative) {
  const realRoot = realpathSync(root);
  const file = realpathSync(path.join(realRoot, relative));
  if (!containsPath(pathKey(realRoot), pathKey(file)))
    throw new Error('Source escapes its root');
  return file;
}
