import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { digest, isDigest, requireValue } from './planning-evidence.mjs';
import {
  assertHostSessionReceipt,
  isHostSessionNotStarted,
  runHostSession,
} from './host-session.mjs';

export function createStageRunner({
  store,
  pool,
  admission,
  recipes,
  timeoutMs,
  faults = {},
  assertCurrent = () => undefined,
}) {
  const operations = new WeakMap();
  async function acquire(value) {
    try {
      return await pool.create('active', { ...value, storeRoot: store.root });
    } catch (error) {
      if (error.code === 'EEXIST' && (await pool.exists('active'))) {
        const active = (await pool.read('active')).value;
        requireValue(
          active.schemaVersion === 1 &&
            isDigest(active.grantId) &&
            isDigest(active.contextDigest) &&
            [
              'attempt',
              'dispatch',
              'implement',
              'verify',
              'review',
              'reconcile',
              'pr-review',
              'architect-approval',
            ].includes(active.phase) &&
            typeof active.nonce === 'string' &&
            /^[a-f0-9-]{36}$/.test(active.nonce) &&
            Number.isSafeInteger(active.ownerPid) &&
            active.ownerPid > 0 &&
            typeof active.storeRoot === 'string' &&
            path.isAbsolute(active.storeRoot),
          'Invalid shared-slot evidence; capacity is uncertain.',
        );
        const busy = new Error('The shared execution slot is occupied.');
        busy.code = 'HOST_POOL_BUSY';
        throw busy;
      }
      throw error;
    }
  }

  async function withAttempt(grant, action) {
    await refresh(grant);
    const slot = await acquire({
      schemaVersion: 1,
      grantId: grant.id,
      phase: 'attempt',
      nonce: randomUUID(),
      contextDigest: grant.contextDigest,
      ownerPid: process.pid,
    });
    const token = Object.freeze({});
    const operation = {
      slot,
      grantId: grant.id,
      sessions: [],
      uncertain: false,
      active: false,
    };
    operations.set(token, operation);
    try {
      return await action(token);
    } finally {
      operations.delete(token);
      if (!operation.uncertain && !operation.active) {
        await store.create(`${grant.id}.attempt-${slot.value.nonce}.cleanup`, {
          slotDigest: slot.digest,
          sessions: operation.sessions,
        });
        await pool.release('active', slot.digest);
      }
    }
  }
  async function refresh(grant) {
    checkCurrent(grant);
    const current = await admission.inspect(grant.request);
    checkCurrent(grant);
    requireValue(
      current.digest === grant.contextDigest,
      'Authoritative issue, claim, policy, scope or source changed.',
    );
    return current.facts;
  }

  function checkCurrent(grant) {
    requireValue(
      assertCurrent(grant) === undefined,
      'The host authority guard must complete synchronously.',
    );
  }

  async function runStage(grant, phase, packet, signal, operation) {
    const subjectDigest = digest(packet);
    const prefix = `${grant.id}.${phase}`;
    await refresh(grant);
    if (await store.exists(`${prefix}.result`)) {
      const result = await store.read(`${prefix}.result`);
      const reservation = (await store.read(`${prefix}.reservation`)).value;
      requireValue(
        result.value.subjectDigest === subjectDigest &&
          result.value.authorityCurrent &&
          result.value.receipt.terminated &&
          result.value.receipt.recipeDigest === recipes[phase].digest &&
          result.value.receipt.nonce === reservation.nonce &&
          result.value.receipt.role === recipes[phase].role &&
          reservation.contextDigest === grant.contextDigest,
        'Stored session result cannot be reused.',
      );
      return result;
    }
    requireValue(
      !(await store.exists(`${prefix}.reservation`)),
      'Session already consumed; uncertain execution is quarantined.',
    );
    const reservation = {
      schemaVersion: 1,
      grantId: grant.id,
      contextDigest: grant.contextDigest,
      phase,
      role: recipes[phase].role,
      nonce: randomUUID(),
      subjectDigest,
      ownerPid: process.pid,
      recipeDigest: recipes[phase].digest,
      ...(operation ? { operationNonce: operation.slot.value.nonce } : {}),
    };
    const slot = operation?.slot ?? (await acquire(reservation));
    let consumed = false;
    let sessionInvoked = false;
    try {
      await refresh(grant);
      await store.create(`${prefix}.reservation`, reservation);
      consumed = true;
      if (operation) operation.uncertain = true;
      await refresh(grant);
      sessionInvoked = true;
      const receipt = await runHostSession({
        recipe: recipes[phase],
        packet,
        workspace: path.join(store.root, `${prefix}.workspace`),
        nonce: reservation.nonce,
        timeoutMs,
        signal,
        fault: faults[phase] ?? null,
        assertBeforeSpawn: () => checkCurrent(grant),
        onSpawn: (launch) =>
          store.create(`${prefix}.launch`, {
            ...launch,
            reservationDigest: digest(reservation),
          }),
      });
      assertHostSessionReceipt(receipt, {
        phase,
        nonce: reservation.nonce,
        packetDigest: subjectDigest,
        allowUnconfirmed: true,
      });
      let authorityCurrent = true;
      try {
        await refresh(grant);
      } catch {
        authorityCurrent = false;
      }
      const result = await store.create(`${prefix}.result`, {
        subjectDigest,
        authorityCurrent,
        receipt,
      });
      if (receipt.terminated) {
        if (operation) {
          operation.sessions.push({
            phase,
            nonce: receipt.nonce,
            pid: receipt.pid,
            resultDigest: result.digest,
          });
          operation.uncertain = false;
        } else await pool.release('active', slot.digest);
      }
      requireValue(
        receipt.terminated && authorityCurrent,
        'Session quarantined: termination or current authority is unconfirmed.',
      );
      return result;
    } catch (error) {
      if (
        consumed &&
        (!sessionInvoked ||
          isHostSessionNotStarted(error, {
            phase,
            nonce: reservation.nonce,
            packetDigest: subjectDigest,
          }))
      ) {
        await store.create(`${prefix}.not-started`, {
          reservationDigest: digest(reservation),
          reason: sessionInvoked
            ? 'host-pre-spawn-guard-rejected'
            : 'host-pre-session-admission-rejected',
        });
        if (operation) operation.uncertain = false;
        else await pool.release('active', slot.digest);
      } else if (!consumed && !operation)
        await pool.release('active', slot.digest);
      throw error;
    }
  }
  async function run(grant, phase, packet, signal, token) {
    const operation = token ? operations.get(token) : null;
    requireValue(
      !token ||
        (operation &&
          operation.grantId === grant.id &&
          !operation.active &&
          ['implement', 'verify'].includes(phase)),
      'Invalid or already active attempt operation lease.',
    );
    if (operation) operation.active = true;
    try {
      return await runStage(grant, phase, packet, signal, operation);
    } finally {
      if (operation) operation.active = false;
    }
  }
  return Object.freeze({ run, refresh, withAttempt });
}

export { inspectRecovery } from './host-recovery.mjs';
