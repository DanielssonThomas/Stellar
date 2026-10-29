import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  advanceImmutableAttempt,
  attemptSchema,
  immutableAttemptFingerprint,
} from './immutable-attempt.mjs';

const journalSchema = 'stellar.immutable-attempt-journal/v1';
const idPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function location(root, id) {
  if (
    !path.isAbsolute(root ?? '') ||
    realpathSync(root) !== path.resolve(root) ||
    !idPattern.test(id ?? '')
  )
    throw new Error('Trusted attempt journal root or ID is invalid.');
  return path.join(root, `attempt-${id}.json`);
}

function envelope(record, revision) {
  if (
    record?.schema !== attemptSchema ||
    !Number.isSafeInteger(revision) ||
    revision < 0
  )
    throw new Error('Invalid immutable attempt journal record.');
  const body = { schema: journalSchema, revision, record };
  return {
    ...body,
    digest: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
  };
}

function syncFile(filename, bytes, flags) {
  const fd = openSync(filename, flags, 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function syncDirectory(filename) {
  if (process.platform === 'win32') return;
  const fd = openSync(path.dirname(filename), 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function readEnvelope(filename) {
  const value = JSON.parse(readFileSync(filename, 'utf8'));
  const valid = envelope(value.record, value.revision);
  if (
    value.schema !== journalSchema ||
    value.digest !== valid.digest ||
    immutableAttemptFingerprint(value.record).length !== 64
  )
    throw new Error('Immutable attempt journal is malformed or altered.');
  return value;
}

export function createImmutableAttemptJournal(root, record) {
  const filename = location(root, record?.id);
  const value = envelope(record, 0);
  syncFile(filename, `${JSON.stringify(value)}\n`, 'wx');
  syncDirectory(filename);
  return { filename, revision: 0, digest: value.digest };
}

export function readImmutableAttemptJournal(root, id) {
  const filename = location(root, id);
  if (existsSync(`${filename}.lock`) || existsSync(`${filename}.pending`))
    throw new Error(
      'Immutable attempt journal has an interrupted update; quarantine required.',
    );
  return readEnvelope(filename);
}

export function updateImmutableAttemptJournal(root, record, expectedDigest) {
  const filename = location(root, record?.id);
  const lock = `${filename}.lock`;
  const pending = `${filename}.pending`;
  const lockFd = openSync(lock, 'wx', 0o600);
  let renamed = false;
  let synchronized = false;
  try {
    const current = readEnvelope(filename);
    const metadata =
      {
        'volume-initialized': { volumeIdentity: record.volumeIdentity },
        running: {
          workerContainerId: record.workerContainerId,
          meterContainerId: record.meterContainerId,
        },
        stopped: { terminationConfirmed: true },
        collected: {
          candidateDigest: record.candidateDigest,
          candidatePath: record.candidatePath,
        },
        verified: {
          verifierContainerId: record.verifierContainerId,
          verificationPassed: true,
          candidateDigest: record.candidateDigest,
        },
      }[record.status] ?? {};
    const expected = advanceImmutableAttempt(
      current.record,
      record.status,
      metadata,
    );
    if (
      current.digest !== expectedDigest ||
      immutableAttemptFingerprint(record) !==
        immutableAttemptFingerprint(expected)
    )
      throw new Error(
        'Stale or inconsistent immutable attempt journal update.',
      );
    const next = envelope(record, current.revision + 1);
    syncFile(pending, `${JSON.stringify(next)}\n`, 'wx');
    renameSync(pending, filename);
    renamed = true;
    syncDirectory(filename);
    synchronized = true;
    return { filename, revision: next.revision, digest: next.digest };
  } finally {
    closeSync(lockFd);
    // A failed directory sync after rename leaves an orphan lock for quarantine.
    if (!renamed || synchronized) unlinkSync(lock);
  }
}

export function inspectInterruptedAttemptJournal(root, id) {
  const filename = location(root, id);
  return {
    lockPresent: existsSync(`${filename}.lock`),
    pendingPresent: existsSync(`${filename}.pending`),
    // Never auto-resume an uncertain container or overwrite a pending update.
    safeToResume: false,
  };
}
