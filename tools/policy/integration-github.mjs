import { dependenciesFromBody } from './issue-worktree.mjs';
import {
  digest,
  isRevision,
  requireValue,
} from './engineering-org/planning-evidence.mjs';

export async function readJson(request, path, options) {
  const response = await request(path, options);
  if (response.status === 404 && options?.allow404 === true) return null;
  requireValue(
    response.status === 200 && response.ok,
    `GitHub evidence ${path} returned ${response.status}.`,
  );
  const value = await response.json();
  digest(value);
  return JSON.parse(JSON.stringify(value));
}

export async function readAll(request, path) {
  const items = [];
  for (let page = 1; page <= 10; page += 1) {
    const response = await request(
      `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`,
    );
    requireValue(
      response.ok && response.status === 200,
      `GitHub list evidence ${path} returned ${response.status}.`,
    );
    const batch = await response.json();
    digest(batch);
    requireValue(
      Array.isArray(batch) && batch.length <= 100,
      `GitHub API ${path} returned an invalid list.`,
    );
    items.push(...batch);
    if (
      batch.length < 100 &&
      !/rel="next"/.test(response.headers?.get('link') ?? '')
    )
      return JSON.parse(JSON.stringify(items));
  }
  throw new Error(`GitHub API ${path} exceeded the bounded pagination limit.`);
}

export async function readCheckRuns(request, sha) {
  requireValue(isRevision(sha), 'An exact check head revision is required.');
  const checks = [];
  let total;
  for (let page = 1; page <= 10; page += 1) {
    const result = await readJson(
      request,
      `/commits/${sha}/check-runs?filter=all&per_page=100&page=${page}`,
    );
    requireValue(
      Number.isSafeInteger(result?.total_count) &&
        result.total_count >= 0 &&
        Array.isArray(result.check_runs) &&
        result.check_runs.length <= 100,
      'GitHub returned invalid exact-head check evidence.',
    );
    total ??= result.total_count;
    requireValue(
      result.total_count === total && total <= 1000,
      'Check evidence changed or exceeds its pagination bound.',
    );
    checks.push(...result.check_runs);
    if (result.check_runs.length < 100) {
      requireValue(
        checks.length === total &&
          checks.every(
            (check) => Number.isSafeInteger(check.id) && check.id > 0,
          ) &&
          new Set(checks.map((check) => check.id)).size === checks.length,
        'Check evidence is incomplete or duplicated.',
      );
      return checks;
    }
  }
  throw new Error('GitHub check runs exceeded the bounded pagination limit.');
}

export async function issueContext(request, number, { repository } = {}) {
  requireValue(
    Number.isSafeInteger(number) &&
      number > 0 &&
      typeof repository === 'string' &&
      /^[\w.-]+\/[\w.-]+$/.test(repository),
    'A positive issue identity and trusted repository are required.',
  );
  const repositoryUrl = `https://api.github.com/repos/${repository}`;
  const matchesRepository = (value) =>
    typeof value === 'string' &&
    value.toLowerCase() === repositoryUrl.toLowerCase();
  const globalIdentity = (value) =>
    Number.isSafeInteger(value?.id) &&
    value.id > 0 &&
    matchesRepository(value.repository_url);
  const issue = await readJson(request, `/issues/${number}`);
  requireValue(
    issue?.number === number &&
      globalIdentity(issue) &&
      !issue.pull_request &&
      typeof issue.body === 'string',
    `Issue #${number} was not found or has invalid identity.`,
  );
  const expected = dependenciesFromBody(issue.body);
  const native = await readAll(
    request,
    `/issues/${number}/dependencies/blocked_by`,
  );
  requireValue(
    new Set(expected).size === expected.length &&
      expected.length === native.length &&
      expected.every((id) =>
        native.some((dependency) => dependency.number === id),
      ),
    `Issue #${number} dependency records do not match.`,
  );
  requireValue(
    native.every(globalIdentity) &&
      new Set(native.map((dependency) => dependency.id)).size === native.length,
    `Issue #${number} native dependency repository or global identity is invalid.`,
  );
  const dependencies = [];
  for (const id of expected.sort((left, right) => left - right)) {
    const declared = native.find((dependency) => dependency.number === id);
    const dependency = await readJson(request, `/issues/${id}`);
    requireValue(
      dependency?.number === id &&
        !dependency.pull_request &&
        globalIdentity(dependency) &&
        dependency.id === declared.id,
      `Dependency #${id} is missing or has invalid identity.`,
    );
    dependencies.push({
      id: dependency.id,
      number: id,
      repository_url: repositoryUrl,
      state: dependency.state,
      labels: dependency.labels,
    });
  }
  return { ...issue, dependencies };
}

export async function readReviewThreads(
  request,
  { repository, repositoryId, pullNumber, headSha },
) {
  const [owner, name] = repository.split('/');
  const threads = [];
  let cursor = null;
  let total;
  const seen = new Set();
  for (let page = 0; page < 10; page += 1) {
    const result = await readJson(request, '/@root/graphql', {
      method: 'POST',
      body: {
        query:
          'query IntegrationReviewThreads($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){databaseId nameWithOwner pullRequest(number:$number){number headRefOid reviewThreads(first:100,after:$cursor){totalCount nodes{id isResolved} pageInfo{hasNextPage endCursor}}}}}',
        variables: { owner, name, number: pullNumber, cursor },
      },
    });
    requireValue(
      !result.errors?.length &&
        result.data?.repository?.databaseId === repositoryId &&
        result.data.repository.nameWithOwner.toLowerCase() ===
          repository.toLowerCase(),
      'Review-thread repository evidence is incomplete.',
    );
    const pull = result.data.repository.pullRequest;
    const connection = pull?.reviewThreads;
    requireValue(
      pull?.number === pullNumber &&
        pull.headRefOid === headSha &&
        Number.isSafeInteger(connection?.totalCount) &&
        connection.totalCount >= 0 &&
        connection.totalCount <= 1000 &&
        Array.isArray(connection.nodes) &&
        connection.nodes.length <= 100 &&
        typeof connection.pageInfo?.hasNextPage === 'boolean',
      'Review-thread identity or pagination evidence is invalid.',
    );
    total ??= connection.totalCount;
    requireValue(
      total === connection.totalCount &&
        connection.nodes.every(
          (thread) =>
            typeof thread.id === 'string' &&
            thread.id &&
            typeof thread.isResolved === 'boolean',
        ),
      'Review-thread evidence changed or is malformed.',
    );
    threads.push(...connection.nodes);
    if (!connection.pageInfo.hasNextPage) {
      requireValue(
        threads.length === total &&
          new Set(threads.map((thread) => thread.id)).size === total,
        'Review-thread evidence is incomplete or duplicated.',
      );
      return threads.sort((left, right) => left.id.localeCompare(right.id));
    }
    cursor = connection.pageInfo.endCursor;
    requireValue(
      typeof cursor === 'string' && cursor && !seen.has(cursor),
      'Review-thread cursor did not advance.',
    );
    seen.add(cursor);
  }
  throw new Error('Review threads exceeded the bounded pagination limit.');
}
