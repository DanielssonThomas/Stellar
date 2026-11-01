import { createHash } from 'node:crypto';

export function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

export const isText = (value) =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 4096;
export const isRevision = (value) =>
  typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);

export function digest(value) {
  const canonical = (item) => {
    if (item === null) return 'null';
    if (typeof item === 'string' || typeof item === 'boolean')
      return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item))
      return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map(canonical).join(',')}]`;
    requireValue(
      item && Object.getPrototypeOf(item) === Object.prototype,
      'Planning evidence must contain only JSON values.',
    );
    return `{${Object.keys(item)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(item[key])}`)
      .join(',')}}`;
  };
  const text = canonical(value);
  requireValue(
    text.length <= 1_000_000,
    'Planning evidence exceeds its bound.',
  );
  return createHash('sha256').update(text).digest('hex');
}

export function timestamp(value) {
  requireValue(
    typeof value === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value,
    'Planning evidence requires a valid UTC timestamp.',
  );
  return Date.parse(value);
}

export function unique(values, name) {
  requireValue(
    Array.isArray(values) && new Set(values).size === values.length,
    `${name} must be an array without duplicates.`,
  );
  return values;
}

export function validateSnapshot(snapshot, now) {
  requireValue(
    snapshot?.schemaVersion === 1 &&
      /^[\w.-]+\/[\w.-]+$/.test(snapshot.repository ?? '') &&
      isRevision(snapshot.revision) &&
      isRevision(snapshot.policyRevision),
    'Trusted planning snapshot identity is invalid.',
  );
  const age = timestamp(now) - timestamp(snapshot.capturedAt);
  requireValue(age >= 0 && age <= 30 * 60_000, 'Planning snapshot is stale.');
  for (const name of ['issues', 'scopes', 'evidence']) {
    requireValue(
      Array.isArray(snapshot[name]) && snapshot[name].length <= 256,
      `Trusted ${name} evidence is missing or exceeds its bound.`,
    );
  }
  unique(
    snapshot.issues.map((issue) => issue.number),
    'Issue identities',
  );
  unique(
    snapshot.scopes.map((scope) => scope.key),
    'Scope identities',
  );
  unique(
    snapshot.evidence.map((entry) => entry.id),
    'Evidence identities',
  );
  unique(snapshot.authorizedWorkers, 'Authorized workers');
  unique(snapshot.targetBranches, 'Target branches');
  requireValue(
    snapshot.targetBranches.every(isText) &&
      snapshot.authorizedWorkers.every((id) => /^[a-z][a-z0-9-]*$/.test(id)),
    'Trusted worker or target identities are invalid.',
  );
  for (const entry of snapshot.evidence) {
    requireValue(
      isText(entry.id) &&
        isText(entry.worker) &&
        isText(entry.skill) &&
        isRevision(entry.revision) &&
        isText(entry.artifact) &&
        ['passed', 'failed'].includes(entry.outcome) &&
        entry.source === 'host-verified-attempt' &&
        timestamp(entry.completedAt) <= timestamp(snapshot.capturedAt),
      'Capability evidence is malformed or not host-verified.',
    );
  }
  return digest(snapshot);
}

export function assessSearch(scope, snapshot) {
  const search = scope.search;
  requireValue(
    search &&
      isText(search.query) &&
      search.openComplete === true &&
      search.recentClosedComplete === true,
    'A complete open and recently closed duplicate search is required.',
  );
  const age = timestamp(snapshot.capturedAt) - timestamp(search.searchedAt);
  const window = timestamp(snapshot.capturedAt) - timestamp(search.closedSince);
  requireValue(
    age >= 0 && age <= 30 * 60_000 && window >= 30 * 24 * 60 * 60_000,
    'Duplicate search is stale or its closed-issue window is too short.',
  );
  unique(search.resultNumbers, 'Search results');
  unique(search.duplicateNumbers, 'Duplicate matches');
  requireValue(
    search.resultNumbers.every((number) =>
      snapshot.issues.some((i) => i.number === number),
    ) &&
      search.duplicateNumbers.every((number) =>
        search.resultNumbers.includes(number),
      ),
    'Duplicate results must refer to trusted issue snapshots.',
  );
  return search.duplicateNumbers;
}

export function assessCapability(scope, snapshot) {
  unique(scope.requiredSkills, 'Required skills');
  requireValue(
    scope.requiredSkills.length > 0 &&
      scope.requiredSkills.length <= 16 &&
      scope.requiredSkills.every(isText),
    'A bounded capability requirement is required.',
  );
  const history = snapshot.evidence.filter(
    (entry) =>
      entry.worker === 'peon' && scope.requiredSkills.includes(entry.skill),
  );
  const failures = history.filter((entry) => entry.outcome === 'failed');
  const missing = scope.requiredSkills.filter((skill) => {
    const attempts = history.filter((entry) => entry.skill === skill);
    const latest = attempts.sort((a, b) =>
      b.completedAt.localeCompare(a.completedAt),
    );
    return (
      !latest.length ||
      latest[0].outcome !== 'passed' ||
      latest.some(
        (entry) =>
          entry.completedAt === latest[0].completedAt &&
          entry.outcome === 'failed',
      )
    );
  });
  return {
    eligible:
      snapshot.authorizedWorkers.includes('peon') && missing.length === 0,
    evidenceIds: history.map((entry) => entry.id).sort(),
    failureIds: failures.map((entry) => entry.id).sort(),
    missingSkills: missing,
  };
}
