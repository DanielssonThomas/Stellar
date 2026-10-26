import { open, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { config } from './ai-review.mjs';

const idPattern = /^[A-Za-z0-9._:/#-]{1,180}$/;
const monthPattern = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const money = (value) => Math.round(value * 1_000_000);

function exactMoney(value) {
  if (!Number.isFinite(value) || value < 0 || value > 1_000_000)
    throw new Error('Invalid trusted dollar amount.');
  return money(value);
}

function parseLedger(data) {
  if (!data) return [];
  if (!data.endsWith('\n'))
    throw new Error(
      'Incomplete spending ledger record; manual recovery required.',
    );
  const records = data
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line));
  const current = new Map();
  for (const entry of records) {
    if (
      !idPattern.test(entry?.key ?? '') ||
      !['reserved', 'committed', 'uncertain'].includes(entry.state) ||
      !monthPattern.test(entry.month ?? '') ||
      !Number.isSafeInteger(entry.reservedMicroUsd) ||
      entry.reservedMicroUsd < 0 ||
      !Number.isSafeInteger(entry.committedMicroUsd) ||
      entry.committedMicroUsd < 0 ||
      entry.committedMicroUsd > entry.reservedMicroUsd
    )
      throw new Error(
        'Invalid spending ledger record; manual recovery required.',
      );
    const prior = current.get(entry.key);
    if (
      prior &&
      (prior.month !== entry.month ||
        prior.sessionId !== entry.sessionId ||
        prior.model !== entry.model ||
        prior.reservedMicroUsd !== entry.reservedMicroUsd ||
        prior.state !== 'reserved')
    )
      throw new Error(
        'Conflicting spending ledger transition; manual recovery required.',
      );
    if (!prior && entry.state !== 'reserved')
      throw new Error('Spending settlement has no reservation.');
    current.set(entry.key, entry);
  }
  return [...current.values()];
}

export function spendingReport(entries, month) {
  if (!monthPattern.test(month ?? ''))
    throw new Error('UTC month is required.');
  const selected = entries.filter((entry) => entry.month === month);
  const reservedMicroUsd = selected.reduce(
    (sum, entry) =>
      sum + (entry.state === 'committed' ? 0 : entry.reservedMicroUsd),
    0,
  );
  const committedMicroUsd = selected.reduce(
    (sum, entry) => sum + entry.committedMicroUsd,
    0,
  );
  const byRoute = {};
  for (const entry of selected) {
    const route = entry.route;
    if (!/^(?:review|architect|foreman|peon|other)$/.test(route ?? ''))
      throw new Error('Invalid spending route.');
    byRoute[route] ??= { requests: 0, reservedUsd: 0, committedUsd: 0 };
    byRoute[route].requests += 1;
    byRoute[route].reservedUsd +=
      entry.state === 'committed' ? 0 : entry.reservedMicroUsd / 1_000_000;
    byRoute[route].committedUsd += entry.committedMicroUsd / 1_000_000;
  }
  return {
    month,
    requests: selected.length,
    reservedUsd: reservedMicroUsd / 1_000_000,
    committedUsd: committedMicroUsd / 1_000_000,
    totalExposureUsd: (reservedMicroUsd + committedMicroUsd) / 1_000_000,
    byRoute,
  };
}

export function planSpendingReservation({
  entries,
  key,
  sessionId,
  route,
  model,
  maxInputTokens,
  maxOutputTokens,
  provider,
  month,
  attempt = 0,
  policy = config,
}) {
  if (!policy.enabled) return { action: 'deny', reason: 'provider-disabled' };
  if (
    !idPattern.test(key ?? '') ||
    !idPattern.test(sessionId ?? '') ||
    !/^(?:review|architect|foreman|peon|other)$/.test(route ?? '') ||
    !monthPattern.test(month ?? '')
  )
    throw new Error('Trusted spending identity is invalid.');
  if (
    !Number.isSafeInteger(attempt) ||
    attempt < 0 ||
    attempt > policy.maxRetriesPerRequest
  )
    return { action: 'deny', reason: 'retry-limit' };
  const existing = entries.find((entry) => entry.key === key);
  if (existing) {
    if (
      existing.sessionId !== sessionId ||
      existing.route !== route ||
      existing.model !== model ||
      existing.month !== month
    )
      return { action: 'deny', reason: 'request-key-conflict' };
    return { action: 'reuse', state: existing.state, key };
  }
  const tier = Object.values(policy.tiers ?? {}).find(
    (item) => item.model === model,
  );
  if (
    !tier ||
    provider?.available !== true ||
    provider.model !== model ||
    provider.pricesVerified !== true ||
    !Number.isFinite(provider.inputUsdPerMillion) ||
    !Number.isFinite(provider.outputUsdPerMillion) ||
    provider.inputUsdPerMillion < 0 ||
    provider.outputUsdPerMillion < 0 ||
    provider.inputUsdPerMillion > tier.maxInputUsdPerMillion ||
    provider.outputUsdPerMillion > tier.maxOutputUsdPerMillion
  )
    return {
      action: 'deny',
      reason: 'provider-unavailable-or-price-unapproved',
    };
  if (
    !Number.isSafeInteger(maxInputTokens) ||
    maxInputTokens < 1 ||
    maxInputTokens > tier.maxInputTokens ||
    !Number.isSafeInteger(maxOutputTokens) ||
    maxOutputTokens < 1 ||
    maxOutputTokens > tier.maxOutputTokens
  )
    return { action: 'deny', reason: 'token-limit' };
  const reservedMicroUsd = Math.ceil(
    maxInputTokens * provider.inputUsdPerMillion +
      maxOutputTokens * provider.outputUsdPerMillion,
  );
  if (
    !Number.isSafeInteger(reservedMicroUsd) ||
    reservedMicroUsd > exactMoney(tier.maxReviewUsd)
  )
    return { action: 'deny', reason: 'per-request-limit' };
  const monthEntries = entries.filter((entry) => entry.month === month);
  if (monthEntries.length >= policy.maxRequestsPerMonth)
    return { action: 'deny', reason: 'monthly-request-limit' };
  const sessionEntries = entries.filter(
    (entry) => entry.sessionId === sessionId,
  );
  if (sessionEntries.length >= policy.maxRequestsPerSession)
    return { action: 'deny', reason: 'session-request-limit' };
  const exposure = (item) =>
    item.state === 'committed' ? item.committedMicroUsd : item.reservedMicroUsd;
  if (
    sessionEntries.reduce(
      (sum, item) => sum + exposure(item),
      reservedMicroUsd,
    ) > exactMoney(policy.maxSessionUsd)
  )
    return { action: 'deny', reason: 'session-spending-limit' };
  if (
    monthEntries.reduce((sum, item) => sum + exposure(item), reservedMicroUsd) >
    exactMoney(policy.monthlyUsd)
  )
    return { action: 'deny', reason: 'monthly-spending-limit' };
  return {
    action: 'reserve',
    entry: {
      key,
      sessionId,
      route,
      model,
      month,
      state: 'reserved',
      reservedMicroUsd,
      committedMicroUsd: 0,
      maxInputTokens,
      maxOutputTokens,
    },
  };
}

export class FileSpendingLedger {
  constructor(filePath, { clock = () => new Date() } = {}) {
    if (!filePath || !resolve(filePath))
      throw new Error('A shared absolute ledger path is required.');
    this.path = resolve(filePath);
    if (this.path !== filePath)
      throw new Error('A shared absolute ledger path is required.');
    this.clock = clock;
  }

  async transaction(callback) {
    const lockPath = `${this.path}.lock`;
    // Never auto-break an abandoned lock: a concurrent writer may still own it.
    const lock = await open(lockPath, 'wx');
    try {
      await lock.writeFile(
        JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
      );
      await lock.sync();
      // A missing journal may have been lost after an earlier paid request.
      // Provision it durably before enabling providers; never create it here.
      const raw = await readFile(this.path, 'utf8');
      const entries = parseLedger(raw);
      const { result, append } = callback(entries);
      if (append) {
        const ledger = await open(this.path, 'r+');
        try {
          const data = Buffer.from(`${JSON.stringify(append)}\n`);
          let position = (await ledger.stat()).size;
          let offset = 0;
          while (offset < data.length) {
            const { bytesWritten } = await ledger.write(
              data,
              offset,
              data.length - offset,
              position,
            );
            if (bytesWritten === 0)
              throw new Error('Ledger append made no progress.');
            offset += bytesWritten;
            position += bytesWritten;
          }
          await ledger.sync();
        } finally {
          await ledger.close();
        }
      }
      return result;
    } finally {
      await lock.close();
      const { unlink } = await import('node:fs/promises');
      await unlink(lockPath);
    }
  }

  reserve(input) {
    if (input?.month !== this.clock().toISOString().slice(0, 7))
      throw new Error('Reservation month differs from the trusted UTC clock.');
    return this.transaction((entries) => {
      const plan = planSpendingReservation({ ...input, entries });
      return {
        result: plan,
        append: plan.action === 'reserve' ? plan.entry : null,
      };
    });
  }

  settle({ key, usage, uncertain = false }) {
    return this.transaction((entries) => {
      const prior = entries.find((entry) => entry.key === key);
      if (!prior || prior.state !== 'reserved')
        throw new Error('Reservation missing or already settled; no retry.');
      if (uncertain) {
        const entry = { ...prior, state: 'uncertain' };
        return { result: entry, append: entry };
      }
      if (
        !Number.isSafeInteger(usage?.inputTokens) ||
        usage.inputTokens < 0 ||
        usage.inputTokens > prior.maxInputTokens ||
        !Number.isSafeInteger(usage?.outputTokens) ||
        usage.outputTokens < 0 ||
        usage.outputTokens > prior.maxOutputTokens ||
        !Number.isFinite(usage?.costUsd) ||
        usage.costUsd < 0 ||
        exactMoney(usage.costUsd) > prior.reservedMicroUsd
      )
        throw new Error(
          'Missing or excessive trusted usage; reservation retained.',
        );
      const entry = {
        ...prior,
        state: 'committed',
        committedMicroUsd: exactMoney(usage.costUsd),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      };
      return { result: entry, append: entry };
    });
  }

  report(month) {
    return this.transaction((entries) => ({
      result: spendingReport(entries, month),
    }));
  }
}

// The caller supplies a trusted provider adapter. This wrapper invokes it once
// only after the shared reservation has been durably committed.
export async function invokeWithSpendingLimit({ ledger, request, invoke }) {
  if (!(ledger instanceof FileSpendingLedger) || typeof invoke !== 'function')
    throw new Error(
      'A trusted shared ledger and provider adapter are required.',
    );
  const reservation = await ledger.reserve(request);
  if (reservation.action !== 'reserve') return reservation;
  let response;
  try {
    response = await invoke({
      model: request.model,
      maxInputTokens: request.maxInputTokens,
      maxOutputTokens: request.maxOutputTokens,
    });
  } catch (error) {
    await ledger.settle({ key: request.key, uncertain: true });
    throw error;
  }
  const settlement = await ledger.settle({
    key: request.key,
    usage: response?.usage,
  });
  return { action: 'complete', settlement, output: response.output };
}
