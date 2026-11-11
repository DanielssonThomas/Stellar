// Issues created before the budget rollout retain their original admission rules.
export const lastPreBudgetIssue = 342;

export function requiresIssueBudget(number) {
  return !number || number > lastPreBudgetIssue;
}

function markdownHeadings(lines) {
  const headings = [];
  let fence;
  let comment = false;
  for (const [index, original] of lines.entries()) {
    let line = original;
    if (!fence) {
      if (comment) {
        const close = line.indexOf('-->');
        if (close === -1) continue;
        line = line.slice(close + 3);
        comment = false;
      }
      line = line.replace(/<!--.*?-->/g, '');
      const open = line.indexOf('<!--');
      if (open !== -1) {
        line = line.slice(0, open);
        comment = true;
      }
    }
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (
        marker?.[1][0] === fence[0] &&
        marker[1].length >= fence.length &&
        !marker[2].trim()
      )
        fence = undefined;
      continue;
    }
    if (marker) {
      fence = marker[1];
      continue;
    }
    const heading = /^#{1,6}[ \t]+(.+?)[ \t]*$/.exec(line);
    if (heading) headings.push({ index, name: heading[1].toLowerCase() });
  }
  return headings;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value, keys) {
  return (
    isObject(value) && Object.keys(value).every((key) => keys.includes(key))
  );
}

function isBoundedText(value, maxLength) {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= maxLength &&
    !/[\p{Cc}\p{Cf}]/u.test(value)
  );
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(
    value,
  );
  if (!match) return null;
  const canonical = `${match[1]}.${(match[2] ?? '').padEnd(3, '0')}Z`;
  const date = new Date(canonical);
  return Number.isFinite(date.getTime()) && date.toISOString() === canonical
    ? canonical
    : null;
}

function readRevision(entry, index, previousTimestamp) {
  const revision = index + 1;
  const fields = [
    'revision',
    'recordedAt',
    'estimatedTokens',
    'allocatedTokens',
    'profile',
    'confidence',
    'evidence',
  ];
  if (!hasOnlyKeys(entry, fields) || entry.revision !== revision)
    throw new Error(
      'Development budget revisions must be consecutive starting at 1.',
    );
  const recordedAt = canonicalTimestamp(entry.recordedAt);
  if (!recordedAt || (previousTimestamp && recordedAt < previousTimestamp))
    throw new Error(
      `Development budget revision ${revision} needs a chronological UTC timestamp.`,
    );
  for (const field of ['estimatedTokens', 'allocatedTokens']) {
    if (!Number.isSafeInteger(entry[field]) || entry[field] < 1)
      throw new Error(
        `Development budget revision ${revision} needs a positive integer ${field}.`,
      );
  }
  if (!isBoundedText(entry.profile, 240))
    throw new Error(
      `Development budget revision ${revision} needs a bounded execution profile.`,
    );
  if (!['low', 'medium', 'high'].includes(entry.confidence))
    throw new Error(
      `Development budget revision ${revision} needs low, medium, or high confidence.`,
    );
  if (
    Object.hasOwn(entry, 'evidence') &&
    (!Array.isArray(entry.evidence) ||
      entry.evidence.length > 10 ||
      entry.evidence.some((reference) => !isBoundedText(reference, 240)))
  )
    throw new Error(
      `Development budget revision ${revision} has invalid evidence references.`,
    );
  return {
    revision,
    recordedAt,
    estimatedTokens: entry.estimatedTokens,
    allocatedTokens: entry.allocatedTokens,
    profile: entry.profile.trim(),
    confidence: entry.confidence,
    ...(entry.evidence
      ? { evidence: entry.evidence.map((reference) => reference.trim()) }
      : {}),
  };
}

function readException(value) {
  if (
    !hasOnlyKeys(value, ['kind', 'reason']) ||
    value.kind !== 'urgent-incident' ||
    !isBoundedText(value.reason, 240)
  )
    throw new Error(
      'Development budget exception needs an urgent-incident kind and a bounded reason.',
    );
  return { kind: value.kind, reason: value.reason.trim() };
}

/** Read normalized, versioned budget data from an issue body. */
export function readIssueBudget(body = '') {
  const lines = body.split(/\r?\n/);
  const headings = markdownHeadings(lines);
  const budgets = headings.filter(({ name }) => name === 'development budget');
  if (!budgets.length) return null;
  if (budgets.length > 1)
    throw new Error('Use exactly one Development budget section.');
  const [{ index }] = budgets;
  const end = headings.find((heading) => heading.index > index)?.index;
  const section = lines
    .slice(index + 1, end)
    .join('\n')
    .trim();
  const json = /^```json[ \t]*\n([\s\S]+)\n```$/i.exec(section)?.[1];
  if (!json)
    throw new Error('Development budget must contain one fenced JSON object.');
  let contract;
  try {
    contract = JSON.parse(json);
  } catch {
    throw new Error('Development budget must contain valid JSON.');
  }
  if (
    !hasOnlyKeys(contract, ['schemaVersion', 'revisions', 'exception']) ||
    contract.schemaVersion !== 1
  )
    throw new Error(
      'Use development budget schemaVersion 1 and its documented fields.',
    );
  const exception = Object.hasOwn(contract, 'exception')
    ? readException(contract.exception)
    : undefined;
  const entries = Object.hasOwn(contract, 'revisions')
    ? contract.revisions
    : [];
  if (
    !Array.isArray(entries) ||
    entries.length > 200 ||
    (!exception && entries.length === 0)
  )
    throw new Error(
      'Development budget needs 1 to 200 revisions or an urgent incident exception.',
    );
  const revisions = [];
  for (const [index, entry] of entries.entries()) {
    revisions.push(readRevision(entry, index, revisions.at(-1)?.recordedAt));
  }
  return { schemaVersion: 1, revisions, ...(exception ? { exception } : {}) };
}

export function admitBudgetRevisions(body, admitted = []) {
  const revisions = readIssueBudget(body ?? '')?.revisions ?? [];
  if (
    !Array.isArray(admitted) ||
    admitted.some(
      (revision, index) =>
        JSON.stringify(revision) !== JSON.stringify(revisions[index]),
    )
  ) {
    throw new Error(
      'Previously admitted development budget revisions are immutable.',
    );
  }
  return revisions;
}

export function issueBudgetErrors(issue, { type, priority, owner }) {
  let budget;
  try {
    budget = readIssueBudget(issue.body ?? '');
  } catch (error) {
    return [error.message];
  }
  if (
    !budget &&
    requiresIssueBudget(issue.number) &&
    !type.includes('type:epic')
  )
    return ['New actionable issues require a Development budget section.'];
  if (
    budget?.exception &&
    (type.includes('type:epic') ||
      !priority.includes('priority:critical') ||
      !owner.some((label) =>
        ['owner:codex', 'owner:maintainer'].includes(label),
      ))
  )
    return [
      'Urgent incident budget exceptions require critical priority and Codex or maintainer ownership.',
    ];
  return [];
}
