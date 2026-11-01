import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { digest, isDigest, requireValue } from './planning-evidence.mjs';
import { planEngineeringWork } from './planning.mjs';

export async function writePlanningRecord(path, packet, snapshot, options) {
  requireValue(
    isAbsolute(path),
    'Planning record requires a trusted absolute path.',
  );
  const record = planEngineeringWork(packet, snapshot, options);
  const envelope = { record, digest: digest(record) };
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(`${JSON.stringify(envelope)}\n`, 'utf8');
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
      (await file.stat()).size <= 1_100_000,
      'Planning record exceeds its bound.',
    );
    content = await file.readFile('utf8');
  } finally {
    await file.close();
  }
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
