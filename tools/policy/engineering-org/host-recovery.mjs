import { digest, requireValue } from './planning-evidence.mjs';

function processAbsent(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
}

export async function inspectRecovery({ store, pool }) {
  if (!(await pool.exists('active')))
    return { status: 'idle', replayAllowed: false };
  const slot = await pool.read('active');
  requireValue(
    slot.value.storeRoot === store.root,
    'Global slot belongs to another host store.',
  );
  const { grantId, phase, ownerPid, nonce } = slot.value;
  const prefix = `${grantId}.${phase}`;
  const response = {
    status: 'quarantined',
    grantId,
    phase,
    nonce,
    replayAllowed: false,
  };
  if (!processAbsent(ownerPid)) return response;
  if (phase === 'attempt') {
    const cleanupName = `${grantId}.attempt-${nonce}.cleanup`;
    if (!(await store.exists(cleanupName))) return response;
    const cleanup = (await store.read(cleanupName)).value;
    requireValue(
      cleanup.slotDigest === slot.digest &&
        Array.isArray(cleanup.sessions) &&
        cleanup.sessions.length <= 2,
      'Attempt cleanup does not bind the shared slot.',
    );
    for (const session of cleanup.sessions) {
      requireValue(
        ['implement', 'verify'].includes(session.phase),
        'Unknown attempt cleanup phase.',
      );
      const saved = (
        await store.read(
          `${grantId}.${session.phase}.result`,
          session.resultDigest,
        )
      ).value;
      const reserved = (
        await store.read(`${grantId}.${session.phase}.reservation`)
      ).value;
      const launch = (await store.read(`${grantId}.${session.phase}.launch`))
        .value;
      requireValue(
        reserved.operationNonce === nonce &&
          launch.reservationDigest === digest(reserved) &&
          launch.nonce === session.nonce &&
          saved.receipt.nonce === session.nonce &&
          saved.receipt.pid === session.pid &&
          launch.pid === session.pid &&
          saved.receipt.terminated === true,
        'Attempt cleanup child identity is inconsistent.',
      );
      if (!processAbsent(session.pid)) return response;
    }
    await pool.release('active', slot.digest);
    return { ...response, status: 'stopped-result-retained' };
  }
  if (
    !(await store.exists(`${prefix}.launch`)) ||
    !(await store.exists(`${prefix}.result`))
  )
    return response;
  const launch = (await store.read(`${prefix}.launch`)).value;
  const result = (await store.read(`${prefix}.result`)).value;
  const reservation = (await store.read(`${prefix}.reservation`)).value;
  const slotReservation = { ...slot.value };
  delete slotReservation.storeRoot;
  requireValue(
    digest(slotReservation) === digest(reservation) &&
      launch.reservationDigest === digest(reservation) &&
      launch.nonce === nonce &&
      result.receipt.nonce === nonce &&
      result.receipt.pid === launch.pid &&
      result.receipt.phase === phase &&
      result.receipt.role === reservation.role &&
      result.receipt.recipeDigest === reservation.recipeDigest &&
      result.receipt.packetDigest === reservation.subjectDigest &&
      result.subjectDigest === reservation.subjectDigest,
    'Recovery journal identity does not match the global slot.',
  );
  if (result.receipt.terminated !== true || !processAbsent(launch.pid))
    return response;
  await pool.release('active', slot.digest);
  return { ...response, status: 'stopped-result-retained' };
}
