import {
  assertFetchedIssue,
  assertNativeDependencySet,
  validateDependencyPage,
  repositoryApiUrl,
} from './issue-dependency-identity.mjs';

export function gitHubCliHostname(apiUrl) {
  if (new URL(apiUrl).href.replace(/\/$/, '') !== 'https://api.github.com')
    throw new Error(
      'The synchronous issue reader supports only the GitHub.com API base.',
    );
  return 'github.com';
}

function* issueRequests(
  number,
  context,
  suppliedIssue,
  { requireBodyAgreement = true } = {},
) {
  const repositoryUrl = repositoryApiUrl(context);
  if (!Number.isSafeInteger(number) || number < 1)
    throw new Error('A positive issue identity is required.');
  const issue = suppliedIssue ?? (yield `/issues/${number}`).value;
  assertFetchedIssue(issue, { ...context, number });
  if (
    typeof issue.body !== 'string' &&
    (requireBodyAgreement || issue.body !== null)
  )
    throw new Error('Issue body is incomplete.');
  const native = [];
  const route = `/issues/${number}/dependencies/blocked_by`;
  let advertisedLastPage = 0;
  for (let page = 1; page <= 10; page += 1) {
    const response = yield `${route}?per_page=100&page=${page}`;
    const { complete, lastPage } = validateDependencyPage({
      items: response.value,
      link: response.link,
      page,
      endpoint: `${repositoryUrl}${route}`,
      advertisedLastPage,
    });
    advertisedLastPage = lastPage;
    native.push(...response.value);
    if (complete) break;
  }
  assertNativeDependencySet(native, issue, context, { requireBodyAgreement });
  const dependencies = [];
  for (const declared of native.sort(
    (left, right) => left.number - right.number,
  )) {
    const dependency = (yield `/issues/${declared.number}`).value;
    assertFetchedIssue(dependency, {
      ...context,
      number: declared.number,
      expectedId: declared.id,
    });
    dependencies.push(dependency);
  }
  return { ...issue, dependencies };
}

function assertResponse(response, route) {
  if (response?.status !== 200)
    throw new Error(
      `GitHub dependency evidence ${route} returned ${response?.status}.`,
    );
}

export async function readIssueDependencies(
  request,
  number,
  context,
  suppliedIssue,
) {
  const steps = issueRequests(number, context, suppliedIssue);
  let step = steps.next();
  while (!step.done) {
    const response = await request(step.value);
    assertResponse(response, step.value);
    step = steps.next({
      value: await response.json(),
      link: response.headers?.get('link') ?? '',
    });
  }
  return step.value;
}

export function readIssueDependenciesSync(request, number, context, options) {
  const steps = issueRequests(number, context, undefined, options);
  let step = steps.next();
  while (!step.done) {
    const response = request(step.value);
    assertResponse(response, step.value);
    step = steps.next(response);
  }
  return step.value;
}

export function parseGitHubRestResponse(output) {
  const normalized = output.replaceAll('\r\n', '\n');
  const split = normalized.indexOf('\n\n');
  const headers = normalized.slice(0, split).split('\n');
  const status = Number(
    headers[0].match(/^HTTP\/\d(?:\.\d)? (\d{3})(?: |$)/)?.[1],
  );
  if (split < 0 || status !== 200)
    throw new Error(
      `GitHub dependency response has missing headers or returned ${status}.`,
    );
  const links = headers.filter((header) => /^link:/i.test(header));
  if (links.length > 1)
    throw new Error('GitHub dependency pagination headers are duplicated.');
  return {
    status,
    value: JSON.parse(normalized.slice(split + 2)),
    link: links[0]?.slice(5).trim() ?? '',
  };
}
