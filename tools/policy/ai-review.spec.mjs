import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  classifyFiles,
  effectiveTier,
  planReview,
  completeReview,
  reserveReview,
  finishReview,
  failReview,
  reviewGate,
} from './ai-review.mjs';

const sha = 'a'.repeat(40);
const pr = {
  repository: 'DanielssonThomas/Stellar',
  number: 104,
  headSha: sha,
  changedFiles: 1,
};
const issue = { number: 103, labels: ['review:light', 'priority:critical'] };
const file = (filename, status = 'modified', previous_filename) => ({
  filename,
  status,
  previous_filename,
});
const enabled = {
  enabled: true,
  monthlyUsd: 20,
  tiers: {
    light: {
      model: 'gpt-6-luna',
      maxInputTokens: 12000,
      maxOutputTokens: 1500,
      maxReviewUsd: 0.1,
      maxInputUsdPerMillion: 2,
      maxOutputUsdPerMillion: 8,
    },
    standard: {
      model: 'gpt-6.1-sol',
      maxInputTokens: 24000,
      maxOutputTokens: 3000,
      maxReviewUsd: 0.25,
      maxInputUsdPerMillion: 5,
      maxOutputUsdPerMillion: 20,
    },
    critical: {
      model: 'gpt-6-astra',
      maxInputTokens: 48000,
      maxOutputTokens: 6000,
      maxReviewUsd: 2,
      maxInputUsdPerMillion: 20,
      maxOutputUsdPerMillion: 80,
    },
  },
};
const prices = {
  model: 'gpt-6-astra',
  inputUsdPerMillion: 20,
  outputUsdPerMillion: 80,
};
const files = [file('tools/policy/ai-review.mjs')];
const args = {
  issue,
  files,
  pr,
  ledger: [],
  now: '2026-10-25T20:00:00Z',
  providerPrices: prices,
  policy: enabled,
};

describe('trusted AI review policy', () => {
  it('classifies rename sides and protects governance and sensitive names', () => {
    assert.equal(classifyFiles([file('docs/guide.md')]), 'light');
    assert.equal(classifyFiles([file('libs/ui/atoms/src/a.ts')]), 'standard');
    for (const path of [
      '.github/workflows/ci.yml',
      '.agents/skills/create-issue/SKILL.md',
      'tools/policy/a.mjs',
      'AGENTS.md',
      'apps/auth/login.ts',
      'config/credentials.json',
      'libs/metering/x.ts',
      'docs/architecture/overview.md',
    ])
      assert.equal(classifyFiles([file(path)]), 'critical', path);
    assert.equal(
      classifyFiles([
        file('docs/readme.md', 'renamed', '.github/workflows/ci.yml'),
      ]),
      'critical',
    );
    assert.throws(
      () => classifyFiles([file('docs/readme.md', 'renamed')]),
      /Rename source/,
    );
    assert.throws(() => classifyFiles([file('../outside.ts')]), /malformed/);
    assert.throws(() => classifyFiles([]), /Complete/);
    assert.throws(
      () => classifyFiles([file('docs/a.md')], { expectedCount: 2 }),
      /count/,
    );
    assert.equal(classifyFiles([file('config/.env.production')]), 'critical');
  });

  it('uses the higher of requested and changed-file tiers', () => {
    assert.equal(effectiveTier(issue, files), 'critical');
    assert.equal(
      effectiveTier({ ...issue, labels: ['review:critical', 'priority:low'] }, [
        file('docs/a.md'),
      ]),
      'critical',
    );
    assert.equal(
      effectiveTier({ number: 102, labels: ['priority:low'] }, [
        file('docs/a.md'),
      ]),
      'standard',
    );
    assert.throws(
      () => effectiveTier({ number: 103, labels: [] }, files),
      /no review tier/,
    );
  });

  it('reserves once per PR head and effective tier', () => {
    const plan = planReview(args);
    assert.equal(plan.action, 'reserve');
    assert.equal(plan.tier, 'critical');
    assert.equal(plan.model, 'gpt-6-astra');
    assert.equal(plan.reserveUsd, 1.44);
    const pending = {
      key: plan.key,
      tier: plan.tier,
      month: plan.month,
      state: 'pending',
      reservedUsd: plan.reserveUsd,
    };
    assert.equal(planReview({ ...args, ledger: [pending] }).action, 'reuse');
    assert.equal(
      reviewGate({ issue, files, pr, ledger: [pending] }).passed,
      false,
    );
    const completed = completeReview(plan, {
      inputTokens: 100,
      outputTokens: 25,
      costUsd: 0.004,
    });
    assert.deepEqual(Object.keys(completed).sort(), [
      'costUsd',
      'inputTokens',
      'key',
      'month',
      'outputTokens',
      'reservedUsd',
      'state',
      'tier',
    ]);
    assert.equal(
      reviewGate({ issue, files, pr, ledger: [completed] }).passed,
      true,
    );
    assert.equal(
      reviewGate({
        issue,
        files,
        pr: { ...pr, headSha: 'b'.repeat(40) },
        ledger: [completed],
      }).passed,
      false,
    );
    assert.equal(
      reviewGate({
        issue: { ...issue, labels: ['review:standard'] },
        files: [file('docs/a.md')],
        pr,
        ledger: [completed],
      }).passed,
      false,
    );
  });

  it('denies disabled providers, unapproved prices, quota exhaustion, and excessive usage', () => {
    assert.equal(
      planReview({ ...args, policy: { ...enabled, enabled: false } }).reason,
      'provider-disabled',
    );
    assert.equal(
      planReview({
        ...args,
        providerPrices: { ...prices, inputUsdPerMillion: 21 },
      }).reason,
      'provider-unavailable-or-price-unapproved',
    );
    assert.equal(
      planReview({ ...args, policy: { ...enabled, monthlyUsd: 1 } }).reason,
      'monthly-limit',
    );
    assert.equal(
      planReview({
        ...args,
        policy: {
          ...enabled,
          tiers: {
            ...enabled.tiers,
            critical: { ...enabled.tiers.critical, maxReviewUsd: 1 },
          },
        },
      }).reason,
      'per-review-limit',
    );
    assert.throws(
      () =>
        completeReview(planReview(args), {
          inputTokens: 48001,
          outputTokens: 1,
          costUsd: 0.01,
        }),
      /exceeds/,
    );
    assert.equal(reviewGate({ issue, files, pr, ledger: [] }).passed, false);
  });

  it('makes one atomic reservation and blocks retry after provider failure', async () => {
    let ledger = [];
    const store = {
      async transact(update) {
        const result = update(ledger);
        ledger = result.ledger;
        return result.result;
      },
    };
    const first = await reserveReview(args, store);
    assert.equal(first.action, 'reserve');
    assert.equal((await reserveReview(args, store)).action, 'reuse');
    await failReview(first, store);
    assert.equal((await reserveReview(args, store)).state, 'failed');
    assert.equal(reviewGate({ issue, files, pr, ledger }).passed, false);
    await assert.rejects(
      finishReview(
        first,
        { inputTokens: 1, outputTokens: 1, costUsd: 0.001 },
        store,
      ),
      /already settled/,
    );
  });

  it('charges completed usage and checks the monthly reservation total', async () => {
    let ledger = [];
    const store = {
      async transact(update) {
        const result = update(ledger);
        ledger = result.ledger;
        return result.result;
      },
    };
    const first = await reserveReview(args, store);
    await finishReview(
      first,
      { inputTokens: 100, outputTokens: 25, costUsd: 0.004 },
      store,
    );
    assert.equal(reviewGate({ issue, files, pr, ledger }).passed, true);
    const next = {
      ...args,
      pr: { ...pr, headSha: 'b'.repeat(40) },
      policy: { ...enabled, monthlyUsd: 1.44 },
    };
    assert.equal((await reserveReview(next, store)).reason, 'monthly-limit');
  });
});
