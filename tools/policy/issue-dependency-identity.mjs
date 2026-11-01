function requireIdentity(condition, message) {
  if (!condition) throw new Error(message);
}

export function repositoryApiUrl({
  repository,
  apiUrl = 'https://api.github.com',
}) {
  requireIdentity(
    typeof repository === 'string' &&
      /^[\w.-]+\/[\w.-]+$/.test(repository) &&
      repository.split('/').every((part) => !/^\.+$/.test(part)),
    'A trusted repository is required for dependency identity.',
  );
  const base = new URL(apiUrl);
  requireIdentity(
    base.protocol === 'https:' &&
      !base.username &&
      !base.password &&
      !base.search &&
      !base.hash,
    'A trusted HTTPS GitHub API base is required.',
  );
  return `${base.href.replace(/\/$/, '')}/repos/${repository}`;
}

export function dependenciesFromBody(body = '') {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) =>
    /^#{1,6}\s+Dependencies\s*$/i.test(line),
  );
  if (start < 0) return null;
  const content = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line)) break;
    content.push(line);
  }
  const value = content.join('\n').trim();
  if (/^(?:none|n\/a)$/i.test(value)) return [];
  return [...value.matchAll(/#(\d+)/g)].map((match) => Number(match[1]));
}

export function assertRepositoryIssue(
  value,
  { repository, apiUrl, number, expectedId },
) {
  const repositoryUrl = repositoryApiUrl({ repository, apiUrl });
  requireIdentity(
    Number.isSafeInteger(number) &&
      number > 0 &&
      value?.number === number &&
      Number.isSafeInteger(value.id) &&
      value.id > 0 &&
      (expectedId === undefined ||
        (Number.isSafeInteger(expectedId) &&
          expectedId > 0 &&
          value.id === expectedId)) &&
      typeof value.repository_url === 'string' &&
      value.repository_url.toLowerCase() === repositoryUrl.toLowerCase() &&
      !Object.hasOwn(value, 'pull_request'),
    `Issue #${number} has invalid identity: repository or global issue ID does not match.`,
  );
  return value;
}

export function assertNativeDependencySet(
  native,
  issue,
  context,
  { requireBodyAgreement = true } = {},
) {
  requireIdentity(
    Array.isArray(native),
    'Native dependency list is incomplete.',
  );
  if (requireBodyAgreement) {
    const expected = dependenciesFromBody(issue.body);
    requireIdentity(
      Array.isArray(expected) &&
        expected.every(
          (number) =>
            Number.isSafeInteger(number) &&
            number > 0 &&
            number !== issue.number,
        ) &&
        new Set(expected).size === expected.length &&
        expected.length === native.length &&
        expected.every((number) =>
          native.some((entry) => entry?.number === number),
        ),
      `Issue #${issue.number} dependency records do not match.`,
    );
  }
  for (const entry of native) {
    assertRepositoryIssue(entry, { ...context, number: entry?.number });
    requireIdentity(
      entry.number !== issue.number && entry.id !== issue.id,
      'An issue cannot depend on its own identity.',
    );
  }
  requireIdentity(
    new Set(native.map((entry) => entry.id)).size === native.length &&
      new Set(native.map((entry) => entry.number)).size === native.length,
    'Native dependency identities are duplicated.',
  );
}

export function assertFetchedIssue(value, context) {
  assertRepositoryIssue(value, context);
  requireIdentity(
    ['open', 'closed'].includes(value.state) &&
      Array.isArray(value.labels) &&
      value.labels.every(
        (label) =>
          typeof (typeof label === 'string' ? label : label?.name) === 'string',
      ),
    `Issue #${value.number} has incomplete state or labels.`,
  );
  return value;
}

export function validateDependencyPage({
  items,
  link,
  page,
  endpoint,
  advertisedLastPage = 0,
}) {
  requireIdentity(
    Array.isArray(items) && items.length <= 100,
    'Native dependency page is not a bounded list.',
  );
  const relations = new Map();
  for (const entry of link ? link.split(',') : []) {
    const match = entry
      .trim()
      .match(
        /^<([^<>]+)>;\s*rel=(?:"(next|prev|first|last)"|(next|prev|first|last))$/,
      );
    requireIdentity(
      match,
      'Native dependency pagination metadata is incomplete.',
    );
    const url = new URL(match[1]);
    const relation = match[2] ?? match[3];
    const targetPage = Number(url.searchParams.get('page'));
    requireIdentity(
      `${url.origin}${url.pathname}`.toLowerCase() === endpoint.toLowerCase() &&
        !url.username &&
        !url.password &&
        !url.hash &&
        url.searchParams.get('per_page') === '100' &&
        [...url.searchParams].length === 2 &&
        Number.isSafeInteger(targetPage) &&
        targetPage > 0 &&
        !relations.has(relation) &&
        (relation !== 'next' || targetPage === page + 1) &&
        (relation !== 'prev' || targetPage === page - 1) &&
        (relation !== 'first' || targetPage === 1),
      'Native dependency pagination identity or order is invalid.',
    );
    relations.set(relation, targetPage);
  }
  const next = relations.has('next');
  const last = relations.get('last');
  requireIdentity(
    (!next || items.length > 0) &&
      (last === undefined ||
        (last <= 10 &&
          (next ? last >= page + 1 : last <= page) &&
          (last >= page || items.length === 0))),
    'Native dependency pagination metadata is incomplete or inconsistent.',
  );
  const complete = items.length < 100 && !next;
  const lastPage = Math.max(
    advertisedLastPage,
    last ?? (next ? page + 1 : page),
  );
  requireIdentity(
    !complete || page >= lastPage,
    'Native dependency pagination ended before its advertised last page.',
  );
  requireIdentity(
    complete || page < 10,
    'Native dependencies exceeded the bounded pagination limit.',
  );
  return { complete, lastPage };
}
