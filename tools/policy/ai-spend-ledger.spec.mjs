import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  FileSpendingLedger,
  invokeWithSpendingLimit,
  planSpendingReservation,
} from './ai-spend-ledger.mjs';
import { config } from './ai-review.mjs';

const root = await mkdtemp(join(tmpdir(), 'stellar-ai-ledger-'));
after(() => rm(root, { recursive: true, force: true }));
const clock = () => new Date('2026-10-25T20:00:00Z');
const policy = {
  enabled: true,
  monthlyUsd: 5,
  maxSessionUsd: 2,
  maxRequestsPerSession: 4,
  maxRetriesPerRequest: 0,
  maxRequestsPerMonth: 20,
  tiers: {
    critical: {
      model: 'simulated-critical',
      maxInputTokens: 48000,
      maxOutputTokens: 6000,
      maxReviewUsd: 2,
      maxInputUsdPerMillion: 20,
      maxOutputUsdPerMillion: 80,
    },
  },
};
const base = {
  key: 'Stellar#42:head:critical',
  sessionId: 'session-one',
  route: 'review',
  model: 'simulated-critical',
  maxInputTokens: 48000,
  maxOutputTokens: 6000,
  month: '2026-10',
  policy,
  provider: {
    available: true,
    pricesVerified: true,
    model: 'simulated-critical',
    inputUsdPerMillion: 20,
    outputUsdPerMillion: 80,
  },
};

describe('durable shared spending ledger', () => {
  it('keeps paid routes disabled by default', () => {
    assert.equal(config.monthlyUsd, 5);
    assert.equal(config.enabled, false);
    assert.equal(
      planSpendingReservation({
        ...base,
        policy: { ...policy, enabled: false },
        entries: [],
      }).reason,
      'provider-disabled',
    );
  });
  it('serializes independent callers and reserves the worst case before use', async () => {
    const store = new FileSpendingLedger(join(root, 'shared.jsonl'), { clock });
    const first = await store.reserve(base);
    assert.equal(first.action, 'reserve');
    assert.equal(first.entry.reservedMicroUsd, 1_440_000);
    assert.deepEqual(await store.reserve(base), {
      action: 'reuse',
      state: 'reserved',
      key: base.key,
    });
    const other = new FileSpendingLedger(store.path, { clock });
    const second = await other.reserve({
      ...base,
      key: 'Stellar#43:head:critical',
      sessionId: 'session-two',
      route: 'architect',
    });
    assert.equal(second.action, 'reserve');
    assert.deepEqual((await store.report('2026-10')).totalExposureUsd, 2.88);
    await store.settle({
      key: base.key,
      usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.003 },
    });
    const report = await other.report('2026-10');
    assert.equal(report.committedUsd, 0.003);
    assert.equal(report.reservedUsd, 1.44);
    assert.equal(report.byRoute.review.requests, 1);
    assert.ok(!JSON.stringify(report).includes('session-one'));
    assert.equal((await other.reserve(base)).state, 'committed');
  });
  it('holds uncertain charges and denies retries or missing usage', async () => {
    const store = new FileSpendingLedger(join(root, 'uncertain.jsonl'), {
      clock,
    });
    await store.reserve(base);
    await assert.rejects(store.settle({ key: base.key, usage: {} }), /usage/);
    assert.equal((await store.report('2026-10')).reservedUsd, 1.44);
    await store.settle({ key: base.key, uncertain: true });
    assert.equal((await store.reserve(base)).state, 'uncertain');
    await assert.rejects(
      store.settle({ key: base.key, uncertain: true }),
      /already settled/,
    );
    assert.equal((await store.report('2026-10')).reservedUsd, 1.44);
    assert.equal(
      planSpendingReservation({
        ...base,
        key: 'retry',
        attempt: 1,
        entries: [],
      }).reason,
      'retry-limit',
    );
  });
  it('calls a simulated provider once after durable reservation', async () => {
    const store = new FileSpendingLedger(join(root, 'simulated.jsonl'), {
      clock,
    });
    let calls = 0;
    const invoke = async (limits) => {
      calls += 1;
      assert.equal(limits.maxOutputTokens, 6000);
      assert.equal((await store.report('2026-10')).reservedUsd, 1.44);
      return {
        output: 'simulated finding',
        usage: { inputTokens: 20, outputTokens: 10, costUsd: 0.001 },
      };
    };
    const first = await invokeWithSpendingLimit({
      ledger: store,
      request: base,
      invoke,
    });
    assert.equal(first.action, 'complete');
    assert.equal(first.output, 'simulated finding');
    const second = await invokeWithSpendingLimit({
      ledger: store,
      request: base,
      invoke,
    });
    assert.equal(second.action, 'reuse');
    assert.equal(calls, 1);
  });
  it('preserves a simulated provider quota failure without retry', async () => {
    const store = new FileSpendingLedger(join(root, 'quota.jsonl'), { clock });
    let calls = 0;
    const invoke = async () => {
      calls += 1;
      throw new Error('quota exhausted');
    };
    await assert.rejects(
      invokeWithSpendingLimit({ ledger: store, request: base, invoke }),
      /quota exhausted/,
    );
    assert.equal(
      (await invokeWithSpendingLimit({ ledger: store, request: base, invoke }))
        .state,
      'uncertain',
    );
    assert.equal(calls, 1);
    assert.equal((await store.report('2026-10')).reservedUsd, 1.44);
  });
  it('denies unknown or unavailable models, prices, and exhausted budgets', () => {
    for (const change of [
      { model: 'unapproved' },
      { provider: { ...base.provider, available: false } },
      { provider: { ...base.provider, pricesVerified: false } },
      { provider: { ...base.provider, inputUsdPerMillion: 21 } },
    ])
      assert.equal(
        planSpendingReservation({ ...base, ...change, entries: [] }).action,
        'deny',
      );
    assert.equal(
      planSpendingReservation({
        ...base,
        entries: [],
        policy: { ...policy, monthlyUsd: 1 },
      }).reason,
      'monthly-spending-limit',
    );
    assert.equal(
      planSpendingReservation({
        ...base,
        entries: [],
        policy: { ...policy, maxSessionUsd: 1 },
      }).reason,
      'session-spending-limit',
    );
    assert.equal(
      planSpendingReservation({ ...base, entries: [], maxOutputTokens: 6001 })
        .reason,
      'token-limit',
    );
  });
  it('fails closed on a held lock and incomplete journal after interruption', async () => {
    const path = join(root, 'interrupted.jsonl');
    const store = new FileSpendingLedger(path, { clock });
    const { writeFile, unlink } = await import('node:fs/promises');
    await writeFile(`${path}.lock`, '{}');
    await assert.rejects(store.reserve(base), /EEXIST/);
    await unlink(`${path}.lock`);
    await writeFile(path, '{"broken":true}');
    await assert.rejects(store.reserve(base), /Incomplete spending ledger/);
    assert.equal(await readFile(path, 'utf8'), '{"broken":true}');
  });
});
