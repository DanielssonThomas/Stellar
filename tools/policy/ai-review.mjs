import { readFileSync } from 'node:fs';

export const config = Object.freeze(
  JSON.parse(
    readFileSync(new URL('./ai-review-config.json', import.meta.url), 'utf8'),
  ),
);
const ranks = Object.freeze({ light: 0, standard: 1, critical: 2 });
const criticalPrefixes = [
  '.agents/',
  '.github/',
  '.husky/',
  'tools/policy/',
  'tools/generators/',
  'docs/architecture/',
];
const criticalExact = new Set([
  'agents.md',
  '.github/codeowners',
  'commitlint.config.cjs',
  'eslint.config.mjs',
  'nx.json',
  'package.json',
  'pnpm-lock.yaml',
  'docs/documentation-policy.md',
  'docs/guides/issue-workflow.md',
  'docs/guides/ai-review-policy.md',
  'docs/guides/agent-worktrees.md',
  'docs/guides/agent-supervision.md',
  'docs/guides/worker-integration-policy.md',
  'docs/guides/worker-security.md',
  '.env',
  '.npmrc',
]);
const sensitiveNames =
  /(?:^|[/._-])(?:secrets?|credentials?|auth(?:entication|orization)?|permissions?|isolation|sandbox|metering|security|tokens?|keyring|vault|billing|budgets?|workflows?)(?:[/._-]|$)/i;
const credentialSuffix = /(?:\.env(?:\..+)?|\.(?:pem|key|p12|pfx|kdbx))$/i;

function pathOf(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.split('/').some((part) => !part || part === '..' || part === '.')
  )
    throw new Error('Changed-file evidence is incomplete or malformed.');
  return value.toLowerCase();
}

export function classifyFiles(files, { expectedCount } = {}) {
  if (!Array.isArray(files) || files.length === 0)
    throw new Error('Complete changed-file evidence is required.');
  if (
    expectedCount !== undefined &&
    (!integer(expectedCount, 1) || files.length !== expectedCount)
  )
    throw new Error('Changed-file evidence count does not match the PR.');
  let rank = 0;
  for (const file of files) {
    if (
      !file ||
      ![
        'added',
        'modified',
        'removed',
        'renamed',
        'copied',
        'changed',
      ].includes(file.status)
    )
      throw new Error('Changed-file status is missing or unsupported.');
    if (file.status === 'renamed' && !file.previous_filename)
      throw new Error('Rename source is required.');
    for (const value of [
      file.filename,
      ...(file.previous_filename ? [file.previous_filename] : []),
    ]) {
      const path = pathOf(value);
      if (
        criticalExact.has(path) ||
        criticalPrefixes.some((prefix) => path.startsWith(prefix)) ||
        sensitiveNames.test(path) ||
        credentialSuffix.test(path)
      )
        rank = 2;
      else if (!path.startsWith('docs/') && !path.endsWith('.md'))
        rank = Math.max(rank, 1);
    }
  }
  return Object.keys(ranks)[rank];
}

export function effectiveTier(issue, files, options) {
  const labels = (issue?.labels ?? []).map((label) =>
    typeof label === 'string' ? label : label.name,
  );
  const requested = labels.filter((label) => label.startsWith('review:'));
  if (
    requested.length > 1 ||
    (requested.length === 1 && !(requested[0].slice(7) in ranks))
  )
    throw new Error('Issue review tier is invalid.');
  // Historical issues may lack a tier; the host supplies a standard floor.
  if (
    !requested.length &&
    (!Number.isInteger(issue?.number) || issue.number > 102)
  )
    throw new Error('New actionable issue has no review tier.');
  const issueTier = requested.length ? requested[0].slice(7) : 'standard';
  const fileTier = classifyFiles(files, options);
  return ranks[issueTier] >= ranks[fileTier] ? issueTier : fileTier;
}

function integer(value, min = 0) {
  return Number.isSafeInteger(value) && value >= min;
}

function validSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

export function reviewKey({ repository, number, headSha, tier }) {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '') ||
    !integer(number, 1) ||
    !validSha(headSha) ||
    !(tier in ranks)
  )
    throw new Error('PR identity is invalid.');
  return `${repository.toLowerCase()}#${number}:${headSha}:${tier}`;
}

function cents(value) {
  return Math.round(value * 10000) / 10000;
}

export function planReview({
  issue,
  files,
  pr,
  ledger = [],
  now,
  providerPrices,
  policy = config,
}) {
  if (!integer(pr?.changedFiles, 1))
    throw new Error('Trusted PR changed-file count is required.');
  const tier = effectiveTier(issue, files, { expectedCount: pr?.changedFiles });
  const key = reviewKey({ ...pr, tier });
  if (!Array.isArray(ledger) || !/^\d{4}-\d{2}$/.test(now?.slice(0, 7) ?? ''))
    throw new Error('Trusted ledger and UTC timestamp are required.');
  const prior = ledger.filter((item) => item.key === key);
  if (prior.length > 1)
    throw new Error('Duplicate review reservations require reconciliation.');
  if (prior.length)
    return { action: 'reuse', key, tier, state: prior[0].state };
  if (!policy.enabled)
    return { action: 'deny', reason: 'provider-disabled', key, tier };
  const route = policy.tiers[tier];
  if (
    !route ||
    !providerPrices ||
    providerPrices.model !== route.model ||
    !Number.isFinite(providerPrices.inputUsdPerMillion) ||
    !Number.isFinite(providerPrices.outputUsdPerMillion) ||
    providerPrices.inputUsdPerMillion < 0 ||
    providerPrices.outputUsdPerMillion < 0 ||
    providerPrices.inputUsdPerMillion > route.maxInputUsdPerMillion ||
    providerPrices.outputUsdPerMillion > route.maxOutputUsdPerMillion
  )
    return {
      action: 'deny',
      reason: 'provider-unavailable-or-price-unapproved',
      key,
      tier,
    };
  const reserveUsd = cents(
    (route.maxInputTokens * providerPrices.inputUsdPerMillion +
      route.maxOutputTokens * providerPrices.outputUsdPerMillion) /
      1e6,
  );
  if (reserveUsd > route.maxReviewUsd)
    return { action: 'deny', reason: 'per-review-limit', key, tier };
  const month = now.slice(0, 7);
  const spentAndReserved = ledger
    .filter((item) => item.month === month)
    .reduce(
      (total, item) =>
        total + (item.state === 'complete' ? item.costUsd : item.reservedUsd),
      0,
    );
  if (
    !Number.isFinite(spentAndReserved) ||
    spentAndReserved < 0 ||
    cents(spentAndReserved + reserveUsd) > policy.monthlyUsd
  )
    return { action: 'deny', reason: 'monthly-limit', key, tier };
  return {
    action: 'reserve',
    key,
    tier,
    month,
    reserveUsd,
    model: route.model,
    maxInputTokens: route.maxInputTokens,
    maxOutputTokens: route.maxOutputTokens,
    maxReviewUsd: route.maxReviewUsd,
  };
}

export function completeReview(reservation, usage, policy = config) {
  const route = policy.tiers[reservation?.tier];
  if (
    reservation?.action !== 'reserve' ||
    !route ||
    !integer(usage?.inputTokens) ||
    !integer(usage?.outputTokens) ||
    usage.inputTokens > route.maxInputTokens ||
    usage.outputTokens > route.maxOutputTokens ||
    !Number.isFinite(usage.costUsd) ||
    usage.costUsd < 0 ||
    usage.costUsd > reservation.reserveUsd ||
    usage.costUsd > route.maxReviewUsd
  )
    throw new Error('Trusted provider usage exceeds review reservation.');
  return {
    key: reservation.key,
    tier: reservation.tier,
    month: reservation.month,
    state: 'complete',
    reservedUsd: reservation.reserveUsd,
    costUsd: cents(usage.costUsd),
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  };
}

// The adapter must serialize a transaction across every PR and persist before
// returning. A provider call may begin only after a successful reservation.
export async function reserveReview(input, store) {
  if (typeof store?.transact !== 'function')
    throw new Error('Atomic trusted review ledger is required.');
  return store.transact((ledger) => {
    const plan = planReview({ ...input, ledger });
    if (plan.action !== 'reserve') return { ledger, result: plan };
    return {
      ledger: [
        ...ledger,
        {
          key: plan.key,
          tier: plan.tier,
          month: plan.month,
          state: 'pending',
          reservedUsd: plan.reserveUsd,
        },
      ],
      result: plan,
    };
  });
}

export async function finishReview(reservation, usage, store, policy = config) {
  if (typeof store?.transact !== 'function')
    throw new Error('Atomic trusted review ledger is required.');
  const completed = completeReview(reservation, usage, policy);
  return store.transact((ledger) => {
    const matches = ledger.filter((entry) => entry.key === reservation.key);
    if (
      matches.length !== 1 ||
      matches[0].state !== 'pending' ||
      matches[0].reservedUsd !== reservation.reserveUsd
    )
      throw new Error('Review reservation is missing or already settled.');
    return {
      ledger: ledger.map((entry) =>
        entry.key === reservation.key ? completed : entry,
      ),
      result: completed,
    };
  });
}

export async function failReview(reservation, store) {
  if (typeof store?.transact !== 'function')
    throw new Error('Atomic trusted review ledger is required.');
  return store.transact((ledger) => {
    const matches = ledger.filter((entry) => entry.key === reservation?.key);
    if (matches.length !== 1 || matches[0].state !== 'pending')
      throw new Error('Review reservation is missing or already settled.');
    const failed = { ...matches[0], state: 'failed' };
    return {
      ledger: ledger.map((entry) =>
        entry.key === reservation.key ? failed : entry,
      ),
      result: failed,
    };
  });
}

export function reviewGate({ issue, files, pr, ledger }) {
  if (!integer(pr?.changedFiles, 1))
    throw new Error('Trusted PR changed-file count is required.');
  const tier = effectiveTier(issue, files, { expectedCount: pr?.changedFiles });
  const key = reviewKey({ ...pr, tier });
  const matches = (ledger ?? []).filter((item) => item.key === key);
  return {
    passed: matches.length === 1 && matches[0].state === 'complete',
    tier,
    key,
  };
}
