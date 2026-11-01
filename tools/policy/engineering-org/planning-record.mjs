import { open } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { isAbsolute } from 'node:path';
import {
  digest,
  isDigest,
  MAX_PLANNING_BYTES,
  requireValue,
} from './planning-evidence.mjs';
import { planEngineeringWork } from './planning.mjs';

export async function writePlanningRecord(path, packet, snapshot, options) {
  requireValue(
    isAbsolute(path),
    'Planning record requires a trusted absolute path.',
  );
  const record = planEngineeringWork(packet, snapshot, options);
  const envelope = { record, digest: digest(record) };
  const content = `${JSON.stringify(envelope)}\n`;
  requireValue(
    Buffer.byteLength(content, 'utf8') <= MAX_PLANNING_BYTES,
    'Planning record exceeds its UTF-8 byte bound.',
  );
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(content, 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
  return envelope.digest;
}

export async function readPlanningRecord(
  path,
  { snapshotDigest, packetDigest, recordDigest },
) {
  requireValue(
    isAbsolute(path),
    'Planning record requires a trusted absolute path.',
  );
  requireValue(
    isDigest(snapshotDigest) &&
      isDigest(packetDigest) &&
      isDigest(recordDigest),
    'Expected planning evidence digests are required.',
  );
  const file = await open(path, 'r');
  let content;
  try {
    requireValue(
      (await file.stat()).size <= MAX_PLANNING_BYTES,
      'Planning record exceeds its bound.',
    );
    content = await file.readFile('utf8');
  } finally {
    await file.close();
  }
  requireValue(
    Buffer.byteLength(content, 'utf8') <= MAX_PLANNING_BYTES,
    'Planning record exceeds its UTF-8 byte bound.',
  );
  const envelope = JSON.parse(content);
  requireValue(
    envelope.digest === recordDigest &&
      recordDigest === digest(envelope.record),
    'Planning record integrity check failed.',
  );
  requireValue(
    envelope.record.schemaVersion === 1 &&
      envelope.record.executionAuthorized === false &&
      envelope.record.snapshotDigest === snapshotDigest &&
      envelope.record.packetDigest === packetDigest,
    'Planning record does not match the expected snapshot and packet.',
  );
  return envelope.record;
}
