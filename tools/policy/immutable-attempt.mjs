import { randomUUID, createHash } from 'node:crypto';

// Infrastructure only. Production correction dispatch remains denied in
// supervised-peon-run.mjs; this module cannot start a container or publish.
export const attemptSchema = 'stellar.immutable-attempt/v1';
const sha256 = /^[a-f0-9]{64}$/;
const revision = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const account = /^[a-z_][a-z0-9_-]{0,31}$/;
const transitions = Object.freeze({
  prepared: ['volume-initialized', 'quarantined'],
  'volume-initialized': ['running', 'quarantined'],
  running: ['stopped', 'quarantined'],
  stopped: ['collected', 'quarantined'],
  collected: ['verified', 'quarantined'],
  verified: ['quarantined', 'cleaned'],
  quarantined: ['cleaned'],
  cleaned: [],
});

function reject(message) {
  throw new Error(message);
}

function checkedPath(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.startsWith('/') ||
    value.includes('\\') ||
    /[:,=\0]/.test(value) ||
    value.split('/').some((part) => !part || part === '.' || part === '..') ||
    value.split('/')[0].toLowerCase() === '.git'
  )
    reject('Unsafe repository-relative path.');
  return value;
}

export function newImmutableAttempt({
  issueNumber,
  sessionId,
  revisionSha,
  snapshotDigest,
  executorAccount,
  executorUid,
  executorGid,
  snapshotPath,
  protectedPaths,
  id = randomUUID(),
}) {
  if (
    !Number.isSafeInteger(issueNumber) ||
    issueNumber < 1 ||
    typeof sessionId !== 'string' ||
    !sessionId ||
    !revision.test(revisionSha ?? '') ||
    !sha256.test(snapshotDigest ?? '') ||
    !account.test(executorAccount ?? '') ||
    executorAccount === 'peon' ||
    !Number.isSafeInteger(executorUid) ||
    executorUid < 1 ||
    executorUid === 1001 ||
    !Number.isSafeInteger(executorGid) ||
    executorGid < 1 ||
    !/^\/var\/lib\/stellar-immutable\/[a-zA-Z0-9_-]+$/.test(
      snapshotPath ?? '',
    ) ||
    !/^[0-9a-f-]{36}$/.test(id ?? '') ||
    !Array.isArray(protectedPaths) ||
    protectedPaths.length === 0
  )
    reject('Incomplete trusted immutable attempt identity.');
  const paths = [...new Set(protectedPaths.map(checkedPath))].sort();
  return Object.freeze({
    schema: attemptSchema,
    id,
    issueNumber,
    sessionId,
    revisionSha,
    snapshotDigest,
    executorAccount,
    executorUid,
    executorGid,
    snapshotPath,
    protectedPaths: paths,
    volumeName: `stellar-immutable-${issueNumber}-${id}`,
    status: 'prepared',
    candidateDigest: null,
  });
}

export function advanceImmutableAttempt(
  record,
  next,
  { candidateDigest } = {},
) {
  if (
    record?.schema !== attemptSchema ||
    !transitions[record.status] ||
    !transitions[record.status].includes(next)
  )
    reject('Invalid immutable attempt transition.');
  if (next === 'collected' && !sha256.test(candidateDigest ?? ''))
    reject('Collection requires a verified candidate digest.');
  if (candidateDigest !== undefined && next !== 'collected')
    reject('Candidate digest can only be set during collection.');
  return Object.freeze({
    ...record,
    status: next,
    ...(next === 'collected' ? { candidateDigest } : {}),
  });
}

export function buildPrivateWorkspaceMounts(
  record,
  volumeName = record?.volumeName,
) {
  if (
    record?.schema !== attemptSchema ||
    record.status !== 'volume-initialized' ||
    volumeName !== record.volumeName ||
    !sha256.test(record.snapshotDigest ?? '')
  )
    reject(
      'Private workspace has not been initialized for this trusted attempt.',
    );
  return [
    `--mount=type=bind,src=${record.snapshotPath},dst=/sealed,ro`,
    `--mount=type=volume,src=${record.volumeName},dst=/workspace`,
    ...record.protectedPaths.map(
      (item) =>
        `--mount=type=bind,src=${record.snapshotPath}/${item},dst=/workspace/${item},ro`,
    ),
  ];
}

export function immutableAttemptFingerprint(record) {
  if (record?.schema !== attemptSchema || !transitions[record.status])
    reject('Invalid immutable attempt record.');
  return createHash('sha256').update(JSON.stringify(record)).digest('hex');
}

export function rejectImmutablePublication() {
  reject(
    'Immutable correction publication remains disabled pending an approved authorization gate.',
  );
}
