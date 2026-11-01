import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { inspectClaim } from '../issue-worktree.mjs';
import { loadIssue } from '../manage-issue-worktree.mjs';
import { effectiveTier } from '../ai-review.mjs';
import { defaultLimits } from '../supervise-worker.mjs';
import {
  inspectClaimedWorktree,
  resolveCurrentDevelopHead,
  validateLivePeonAssignment,
} from '../supervised-peon-run.mjs';
import {
  assessCapability,
  digest,
  isDigest,
  isRevision,
  isText,
  MAX_PLANNING_BYTES,
  requireValue,
  timestamp,
  unique,
  validateSnapshot,
} from './planning-evidence.mjs';

const repository = 'DanielssonThomas/Stellar';
const configuredRepository = process.env.GITHUB_REPOSITORY ?? repository;
const limits = { ...defaultLimits, maxAttemptsPerWorker: 1 };
const admissions = new WeakSet();

export function assertRepositoryAdmission(admission) {
  requireValue(
    admissions.has(admission),
    'A host-created repository admission is required.',
  );
  return admission;
}

function detached(value) {
  digest(value);
  return JSON.parse(JSON.stringify(value));
}

function normalizedIssue(issue) {
  return detached({
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels
      .map((label) => (typeof label === 'string' ? label : label.name))
      .sort(),
    dependencies: [...issue.dependencies].sort((a, b) => a.number - b.number),
  });
}

export function repositoryIssueDigest(issue) {
  return digest(normalizedIssue(issue));
}

function policyHead(repositoryRoot) {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
  }).trim();
}

async function canonicalPath(path) {
  requireValue(
    typeof path === 'string' && isAbsolute(path),
    'An absolute host path is required.',
  );
  const canonical = await realpath(path);
  const compare = (value) =>
    process.platform === 'win32' ? value.toLowerCase() : value;
  requireValue(
    compare(canonical) === compare(resolve(path)),
    'Host paths must not traverse symbolic links.',
  );
  return canonical;
}

async function readScope(path, expectedDigest) {
  await canonicalPath(path);
  const metadata = await lstat(path, { bigint: true });
  requireValue(
    metadata.isFile() && metadata.nlink === 1n,
    'Scope receipt must be a regular, unlinked host file.',
  );
  const file = await open(path, 'r');
  let content;
  try {
    const opened = await file.stat({ bigint: true });
    // Windows path stats can omit the volume ID that handle stats expose.
    const sameDevice =
      opened.dev === metadata.dev ||
      (process.platform === 'win32' && metadata.dev === 0n);
    requireValue(
      opened.isFile() &&
        opened.nlink === 1n &&
        opened.ino === metadata.ino &&
        sameDevice,
      'Scope receipt identity changed while opening its handle.',
    );
    requireValue(
      opened.size <= MAX_PLANNING_BYTES,
      'Scope receipt exceeds its byte bound.',
    );
    const buffer = Buffer.alloc(MAX_PLANNING_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    requireValue(
      length <= MAX_PLANNING_BYTES,
      'Scope receipt exceeds its byte bound.',
    );
    const after = await file.stat({ bigint: true });
    requireValue(
      after.nlink === 1n &&
        after.size === opened.size &&
        BigInt(length) === opened.size &&
        after.mtimeNs === opened.mtimeNs &&
        after.ctimeNs === opened.ctimeNs,
      'Scope receipt changed during its read.',
    );
    content = new TextDecoder('utf-8', { fatal: true }).decode(
      buffer.subarray(0, length),
    );
  } finally {
    await file.close();
  }
  requireValue(
    Buffer.byteLength(content, 'utf8') <= MAX_PLANNING_BYTES,
    'Scope receipt exceeds its byte bound.',
  );
  const record = JSON.parse(content);
  requireValue(
    digest(record) === expectedDigest,
    'Scope receipt does not match its trusted digest.',
  );
  return record;
}

function acceptanceCriteria(body) {
  const section = body
    .split(/^## Acceptance criteria\s*$/m)[1]
    ?.split(/^## /m)[0];
  return [...(section ?? '').matchAll(/^- \[ \] (.+)$/gm)].map((match) =>
    match[1].trim(),
  );
}

function admitScope(record, issue, now) {
  const { scope } = record;
  requireValue(
    scope?.complexity === 'small' &&
      scope.ambiguous === false &&
      ['light', 'standard'].includes(scope.riskFloor),
    'Sensitive, complex or ambiguous scope requires escalation.',
  );
  requireValue(
    Array.isArray(scope.files) &&
      scope.files.length > 0 &&
      scope.files.length <= 128,
    'Bounded scope files are required.',
  );
  const tier = effectiveTier(issue, scope.files, {
    expectedCount: scope.files.length,
  });
  requireValue(tier !== 'critical', 'Sensitive scope requires escalation.');
  const allowedPaths = unique(
    scope.files.flatMap((file) => [
      file.filename,
      ...(file.previous_filename ? [file.previous_filename] : []),
    ]),
    'Allowed paths',
  ).sort();
  requireValue(
    allowedPaths.every((path) => !path.includes(':') && !path.includes('\0')),
    'Scope paths are invalid.',
  );
  const descriptions = acceptanceCriteria(issue.body);
  requireValue(
    Array.isArray(scope.criteria) &&
      scope.criteria.length > 0 &&
      scope.criteria.length <= 64 &&
      scope.criteria.every(
        (criterion) => isText(criterion.id) && isText(criterion.description),
      ),
    'Bounded acceptance criteria are required.',
  );
  unique(
    scope.criteria.map((criterion) => criterion.id),
    'Criterion identities',
  );
  requireValue(
    digest(scope.criteria.map((criterion) => criterion.description)) ===
      digest(descriptions),
    'Scope criteria do not match the current issue.',
  );
  validateSnapshot(
    {
      schemaVersion: 1,
      repository,
      revision: record.sourceRevision,
      policyRevision: record.policyRevision,
      capturedAt: now,
      issues: [],
      scopes: [],
      evidence: record.evidence,
      authorizedWorkers: record.authorizedWorkers,
      targetBranches: ['develop'],
    },
    now,
  );
  const capability = assessCapability(scope, record);
  requireValue(
    capability.eligible,
    'Verified Peon capability evidence is missing or failed.',
  );
  requireValue(
    digest(record.limits) === digest(limits),
    'Scope receipt must retain the conservative one-attempt limits.',
  );
  return { scope: { ...scope, allowedPaths }, capability };
}

export function createRepositoryAdmission({
  repositoryRoot,
  scopeRecordPath,
  scopeRecordDigest,
  hostReaders = {},
}) {
  requireValue(
    isDigest(scopeRecordDigest),
    'A host-retained scope receipt digest is required.',
  );
  requireValue(
    configuredRepository === repository &&
      (process.env.GITHUB_REPOSITORY ?? repository) === repository,
    'Admission requires the configured Stellar repository.',
  );
  const readers = {
    loadIssue,
    inspectClaim,
    resolveDevelopHead: resolveCurrentDevelopHead,
    now: () => new Date().toISOString(),
    ...hostReaders,
  };
  requireValue(
    Object.keys(readers).every((key) =>
      ['loadIssue', 'inspectClaim', 'resolveDevelopHead', 'now'].includes(key),
    ) && Object.values(readers).every((reader) => typeof reader === 'function'),
    'Only trusted read-only admission readers may be configured.',
  );

  async function capture({ issueNumber, sessionId }) {
    const root = await canonicalPath(repositoryRoot);
    const record = await readScope(scopeRecordPath, scopeRecordDigest);
    const issue = normalizedIssue(await readers.loadIssue(issueNumber));
    const claim = detached(await readers.inspectClaim(root, issueNumber));
    const now = readers.now();
    timestamp(now);
    requireValue(
      issue.number === issueNumber && claim?.issue === issueNumber,
      'Issue and claim identities do not match admission.',
    );
    const assignment = validateLivePeonAssignment({
      issue,
      claim,
      sessionId,
      now: Date.parse(now),
    });
    const worktree = await canonicalPath(claim.worktreePath);
    const receiptRelative = relative(worktree, resolve(scopeRecordPath));
    requireValue(
      receiptRelative === '..' ||
        receiptRelative.startsWith(`..${sep}`) ||
        isAbsolute(receiptRelative),
      'Scope receipt must remain outside the worker worktree.',
    );
    const registered = inspectClaimedWorktree(root, claim);
    const sourceRevision = await readers.resolveDevelopHead(root);
    const policyRevision = policyHead(root);
    requireValue(
      isRevision(sourceRevision) &&
        isRevision(policyRevision) &&
        registered.clean &&
        registered.headRevision === sourceRevision,
      'Admission requires a clean registered worktree at current develop.',
    );
    requireValue(
      record.schemaVersion === 1 &&
        record.repository === repository &&
        record.issueNumber === issueNumber &&
        record.sessionId === sessionId &&
        record.sourceRevision === sourceRevision &&
        record.policyRevision === policyRevision &&
        record.issueDigest === digest(issue),
      'Scope receipt is stale or does not match current authority.',
    );
    const { scope, capability } = admitScope(record, issue, now);
    return detached({
      repository,
      issue,
      claim,
      assignment,
      sourceRevision,
      policyRevision,
      scope,
      capability,
      scopeRecordDigest,
      limits,
    });
  }

  const admission = Object.freeze({
    async inspect({ issueNumber, sessionId }) {
      requireValue(
        Number.isSafeInteger(issueNumber) &&
          issueNumber > 0 &&
          typeof sessionId === 'string' &&
          /^[a-zA-Z0-9._:-]{1,128}$/.test(sessionId),
        'A positive issue and stable supervisor session are required.',
      );
      const first = await capture({ issueNumber, sessionId });
      const facts = await capture({ issueNumber, sessionId });
      const contextDigest = digest(facts);
      requireValue(
        contextDigest === digest(first),
        'Repository authority changed during admission.',
      );
      const checkedAt = readers.now();
      timestamp(checkedAt);
      requireValue(
        Date.parse(facts.claim.expiresAt) > Date.parse(checkedAt),
        'Issue claim expired during admission.',
      );
      return { facts, digest: contextDigest, checkedAt };
    },
  });
  admissions.add(admission);
  return admission;
}
