import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateIssue } from './validate-issue.mjs';
import { evaluateWorkerPullRequest } from './worker-integration-gate.mjs';

const apiVersion = '2026-03-10';
const requiredChecks = ['verify'];

function labelsOf(issue) {
  return (issue.labels ?? []).map((label) =>
    typeof label === 'string' ? label : (label?.name ?? ''),
  );
}

function jsonApi({ token, apiUrl = 'https://api.github.com', repository }) {
  if (typeof token !== 'string' || !token)
    throw new Error('STELLAR_INTEGRATION_TOKEN is required.');
  if (!/^[^/]+\/[^/]+$/.test(repository ?? ''))
    throw new Error('GITHUB_REPOSITORY must be owner/repository.');

  return async function request(
    path,
    { method = 'GET', body, allow404 = false, allowStatuses = [] } = {},
  ) {
    const url = path.startsWith('/@root/')
      ? `${apiUrl}/${path.slice('/@root/'.length)}`
      : `${apiUrl}/repos/${repository}${path}`;
    const response = await fetch(url, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': apiVersion,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (
      !response.ok &&
      !(allow404 && response.status === 404) &&
      !allowStatuses.includes(response.status)
    )
      throw new Error(
        `GitHub API ${method} ${path} returned ${response.status}.`,
      );
    return response;
  };
}

async function readJson(request, path, options) {
  const response = await request(path, options);
  return response.status === 404 ? null : response.json();
}

async function readAll(request, path) {
  const result = [];
  for (let page = 1; page <= 10; page += 1) {
    const separator = path.includes('?') ? '&' : '?';
    const response = await request(
      `${path}${separator}per_page=100&page=${page}`,
    );
    if (!response.ok)
      throw new Error(`GitHub list request returned ${response.status}.`);
    const items = await response.json();
    if (!Array.isArray(items))
      throw new Error(`GitHub API ${path} returned an invalid list.`);
    result.push(...items);
    if (items.length < 100) return result;
  }
  throw new Error(`GitHub API ${path} exceeded the bounded pagination limit.`);
}

async function readCheckRuns(request, sha) {
  const checks = [];
  for (let page = 1; page <= 10; page += 1) {
    const result = await readJson(
      request,
      `/commits/${sha}/check-runs?per_page=100&page=${page}`,
    );
    if (!Array.isArray(result?.check_runs))
      throw new Error('GitHub returned invalid exact-head check evidence.');
    checks.push(...result.check_runs);
    if (result.check_runs.length < 100) return checks;
  }
  throw new Error('GitHub check runs exceeded the bounded pagination limit.');
}

function normalizeWorkerConfig(value) {
  if (!Array.isArray(value))
    throw new Error('Worker identity policy is invalid.');
  const ids = new Set();
  const workers = new Map();
  for (const entry of value) {
    if (
      !entry ||
      typeof entry.id !== 'string' ||
      !/^[a-z0-9][a-z0-9-]*$/.test(entry.id) ||
      typeof entry.forkFullName !== 'string' ||
      !/^[^/]+\/[^/]+$/.test(entry.forkFullName) ||
      (entry.pullRequestActor !== undefined &&
        typeof entry.pullRequestActor !== 'string')
    )
      throw new Error('Worker identity policy contains an invalid entry.');
    if (ids.has(entry.id))
      throw new Error('Worker identity policy has duplicate IDs.');
    ids.add(entry.id);
    workers.set(entry.id, entry);
  }
  return { ids: [...ids], workers };
}

function dependenciesFromBody(body) {
  const section =
    body.match(
      /^#{1,6}\s+Dependencies\s*\r?\n([\s\S]*?)(?=^#{1,6}\s|\s*$)/im,
    )?.[1] ?? '';
  if (/^\s*(?:none|n\/a)\s*$/i.test(section)) return [];
  return [...section.matchAll(/#([1-9][0-9]*)/g)].map((match) =>
    Number(match[1]),
  );
}

async function issueContext(request, number) {
  const issue = await readJson(request, `/issues/${number}`);
  if (!issue || issue.pull_request)
    throw new Error(`Issue #${number} was not found.`);
  const expected = dependenciesFromBody(issue.body ?? '');
  const native = await readAll(
    request,
    `/issues/${number}/dependencies/blocked_by`,
  );
  if (
    expected.length !== native.length ||
    expected.some(
      (id) => !native.some((dependency) => dependency.number === id),
    )
  )
    throw new Error(`Issue #${number} dependency records do not match.`);
  const dependencies = [];
  for (const id of expected) {
    const dependency = await readJson(request, `/issues/${id}`);
    if (!dependency || dependency.pull_request)
      throw new Error(`Dependency #${id} is missing or is a pull request.`);
    dependencies.push({
      number: dependency.number,
      state: dependency.state,
      labels: dependency.labels,
    });
  }
  return { ...issue, dependencies };
}

async function appendComment(request, issueNumber, comment) {
  await request(`/issues/${issueNumber}/comments`, {
    method: 'POST',
    body: { body: comment },
  });
}

async function replaceStatus(request, issue, expected, next) {
  const fresh = await issueContext(request, issue.number);
  const labels = labelsOf(fresh);
  if (fresh.state !== 'open' || !labels.includes(expected))
    throw new Error(`Issue #${issue.number} changed before status update.`);
  const updated = labels.filter((label) => !label.startsWith('status:'));
  updated.push(next);
  await request(`/issues/${issue.number}`, {
    method: 'PATCH',
    body: { labels: updated },
  });
}

function validActionableIssue(issue, workerIds) {
  const result = validateIssue(issue, { authorizedWorkers: workerIds });
  if (!result.valid)
    throw new Error(
      `Issue #${issue.number} metadata is invalid: ${result.errors.join(' ')}`,
    );
}

function integrationBody(issue) {
  const expected = issue.body
    .match(
      /^#{1,6}\s+Expected outcome\s*\r?\n([\s\S]*?)(?=^#{1,6}\s|\s*$)/im,
    )?.[1]
    ?.trim();
  return [
    `Fixes #${issue.number}`,
    '',
    '## Summary',
    expected || `Implements the accepted scope for issue #${issue.number}.`,
    '',
    '## Verification',
    'See the linked issue and the required `verify` check for this exact PR head.',
    '',
    '## Documentation',
    'Documentation impact is recorded in the issue and reviewed with the change.',
  ].join('\n');
}

async function createPullRequest(
  request,
  { issueNumber, workerConfig, fetchImpl },
) {
  const issue = await issueContext(request, issueNumber);
  validActionableIssue(issue, workerConfig.ids);
  const labels = labelsOf(issue);
  const workerId = labels
    .find((label) => label.startsWith('worker:'))
    ?.slice(7);
  const worker = workerConfig.workers.get(workerId);
  if (!worker)
    throw new Error('The issue owner has no trusted fork and actor mapping.');
  if (
    !['status:in-progress', 'status:ready'].some((label) =>
      labels.includes(label),
    )
  )
    throw new Error('Issue must be ready or in progress before PR creation.');

  const branches = await readAll(async (path, options = {}) => {
    const response = await fetchImpl(
      new URL(
        path.replace(/^\//, ''),
        `https://api.github.com/repos/${worker.forkFullName}/`,
      ),
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': apiVersion,
        },
        ...options,
      },
    );
    if (!response.ok)
      throw new Error(
        `Authorized worker fork branch lookup returned ${response.status}.`,
      );
    return response;
  }, '/branches');
  const candidates = branches
    .map((branch) => branch.name)
    .filter((name) => name.startsWith(`issue/${issueNumber}-`));
  if (candidates.length !== 1)
    throw new Error(
      `Expected exactly one issue branch on the authorized fork; found ${candidates.length}.`,
    );
  const headOwner = worker.forkFullName.split('/')[0];
  const head = `${headOwner}:${candidates[0]}`;
  const existing = await readAll(
    request,
    `/pulls?state=open&base=develop&head=${encodeURIComponent(head)}`,
  );
  let pullRequest = existing[0];
  if (!pullRequest) {
    const response = await request('/pulls', {
      method: 'POST',
      body: {
        title: issue.title,
        head,
        base: 'develop',
        body: integrationBody(issue),
        draft: false,
      },
    });
    pullRequest = await response.json();
  }
  const actor = await readJson(request, '/@root/user');
  if (
    !actor?.login ||
    pullRequest.user?.login?.toLowerCase() !== actor.login.toLowerCase()
  )
    throw new Error(
      'Created or existing PR actor does not match the trusted integration identity.',
    );
  if (
    !new RegExp(
      `(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${issueNumber}\\b`,
      'i',
    ).test(pullRequest.body ?? '')
  )
    throw new Error('PR body does not link the issue.');

  if (labels.includes('status:in-progress'))
    await replaceStatus(request, issue, 'status:in-progress', 'status:review');
  await appendComment(
    request,
    issueNumber,
    `Supervisor runner recorded PR #${pullRequest.number} for authorized fork branch \`${candidates[0]}\`. The worker did not receive upstream credentials.`,
  );
  return {
    pullRequest: pullRequest.number,
    headSha: pullRequest.head?.sha ?? null,
  };
}

async function integrationEvidence(
  request,
  issueNumber,
  pullNumber,
  workerConfig,
) {
  const issue = await issueContext(request, issueNumber);
  const pull = await readJson(request, `/pulls/${pullNumber}`);
  if (!issue || issue.pull_request || !pull)
    throw new Error('Issue or pull request was not found.');
  const workerId = labelsOf(issue)
    .find((label) => label.startsWith('worker:'))
    ?.slice(7);
  const worker = workerConfig.workers.get(workerId);
  const commits = await readAll(request, `/pulls/${pullNumber}/commits`);
  const changedFiles = await readAll(request, `/pulls/${pullNumber}/files`);
  const checks = await readCheckRuns(request, pull.head.sha);
  const base = await readJson(request, '/branches/develop');
  if (!base?.commit?.sha)
    throw new Error('Could not read the authorized develop head.');
  const codeowners = await readJson(
    request,
    ` /contents/.github/CODEOWNERS?ref=${base.commit.sha}`.trimStart(),
  );
  if (!codeowners?.content || codeowners.encoding !== 'base64')
    throw new Error(
      'Could not read CODEOWNERS from the authorized develop revision.',
    );
  const decision = evaluateWorkerPullRequest({
    issue,
    pullRequest: {
      number: pull.number,
      state: pull.state,
      isDraft: pull.draft,
      body: pull.body,
      baseRefName: pull.base?.ref,
      headRefName: pull.head?.ref,
      headRepoFullName: pull.head?.repo?.full_name,
      authorLogin: pull.user?.login,
      headSha: pull.head?.sha,
    },
    worker,
    integrationActor: (await readJson(request, '/@root/user'))?.login,
    authorizedWorkerIds: workerConfig.ids,
    commits: commits.map((commit) => ({ message: commit.commit?.message })),
    checks:
      checks.map((check) => ({
        name: check.name,
        headSha: check.head_sha,
        conclusion: check.conclusion,
      })) ?? [],
    changedFiles,
    codeowners: Buffer.from(codeowners.content, 'base64').toString('utf8'),
    requiredChecks,
    allowedTargets: ['develop'],
  });
  return { issue, pull, baseSha: base.commit.sha, decision };
}

async function recordDenial(request, evidence) {
  const { issue, pull, decision } = evidence;
  const reason = decision.reasons.join(', ') || 'policy-evaluation-failed';
  await appendComment(
    request,
    pull.number,
    `Trusted integration denied for head \`${pull.head.sha}\`. Reason codes: ${reason}. The PR remains open for review.`,
  );
  await appendComment(
    request,
    issue.number,
    `Trusted integration denied for PR #${pull.number}, head \`${pull.head.sha}\`. Reason codes: ${reason}.`,
  );
}

async function integratePullRequest(
  request,
  { issueNumber, pullNumber, workerConfig },
) {
  const evidence = await integrationEvidence(
    request,
    issueNumber,
    pullNumber,
    workerConfig,
  );
  if (!evidence.decision.eligible) {
    await recordDenial(request, evidence);
    return { merged: false, reasons: evidence.decision.reasons };
  }
  const latestPull = await readJson(request, `/pulls/${pullNumber}`);
  const latestBase = await readJson(request, '/branches/develop');
  const latestIssue = await issueContext(request, issueNumber);
  const latestChecks = await readCheckRuns(request, evidence.pull.head.sha);
  const issueEvidenceMatches =
    latestIssue.state === evidence.issue.state &&
    latestIssue.body === evidence.issue.body &&
    JSON.stringify(labelsOf(latestIssue).sort()) ===
      JSON.stringify(labelsOf(evidence.issue).sort()) &&
    JSON.stringify(
      (latestIssue.dependencies ?? [])
        .map((dependency) => ({
          number: dependency.number,
          state: dependency.state,
          labels: labelsOf(dependency).sort(),
        }))
        .sort((left, right) => left.number - right.number),
    ) ===
      JSON.stringify(
        (evidence.issue.dependencies ?? [])
          .map((dependency) => ({
            number: dependency.number,
            state: dependency.state,
            labels: labelsOf(dependency).sort(),
          }))
          .sort((left, right) => left.number - right.number),
      );
  const pullEvidenceMatches =
    latestPull?.state === 'open' &&
    latestPull.head?.sha === evidence.decision.headSha &&
    latestPull.base?.ref === 'develop' &&
    latestBase?.commit?.sha === evidence.baseSha &&
    latestChecks.some(
      (check) =>
        check.name === 'verify' &&
        check.head_sha === evidence.decision.headSha &&
        check.conclusion === 'success',
    );
  if (!issueEvidenceMatches || !pullEvidenceMatches) {
    const stale = {
      ...evidence,
      decision: {
        ...evidence.decision,
        eligible: false,
        reasons: [
          ...(issueEvidenceMatches
            ? []
            : ['issue-evidence-changed-before-merge']),
          ...(pullEvidenceMatches ? [] : ['evidence-changed-before-merge']),
        ],
      },
    };
    await recordDenial(request, stale);
    return { merged: false, reasons: stale.decision.reasons };
  }
  const merge = await request(`/pulls/${pullNumber}/merge`, {
    method: 'PUT',
    body: { sha: evidence.decision.headSha, merge_method: 'squash' },
    allowStatuses: [405, 409],
  });
  if (merge.status === 405 || merge.status === 409)
    throw new Error(
      `GitHub refused the protected merge with status ${merge.status}.`,
    );
  const result = await merge.json();
  if (!result.merged)
    throw new Error('GitHub did not confirm the exact-head merge.');
  await appendComment(
    request,
    issueNumber,
    `Trusted runner merged eligible PR #${pullNumber} at exact head \`${evidence.decision.headSha}\` using the protected squash merge operation. No bypass was requested.`,
  );
  return {
    merged: true,
    headSha: evidence.decision.headSha,
    mergeSha: result.sha,
  };
}

async function verifyCredentialBoundary(request, issueNumber) {
  const actor = await readJson(request, '/@root/user');
  if (!actor?.login)
    throw new Error(
      'Integration credential could not identify its GitHub principal.',
    );
  const repository = await readJson(request, '');
  if (!repository?.full_name)
    throw new Error(
      'Integration credential cannot read the configured repository.',
    );
  const issue = await readJson(request, `/issues/${issueNumber}`);
  if (!issue || issue.pull_request)
    throw new Error('Permission verification issue was not found.');
  const adminRead = await request('/actions/permissions', {
    allow404: true,
    allowStatuses: [403],
  });
  if (adminRead.ok)
    throw new Error(
      'Integration credential can read repository Actions administration; least-privilege verification failed.',
    );
  if (adminRead.status !== 403 && adminRead.status !== 404)
    throw new Error(
      `Unexpected Actions administration permission probe result ${adminRead.status}.`,
    );
  await appendComment(
    request,
    issueNumber,
    `Trusted integration credential boundary probe passed at ${new Date().toISOString()}: authenticated as \`${actor.login}\`, repository read and issue comment succeeded, and repository Actions administration read was denied (HTTP ${adminRead.status}). No repository code, PR, or merge operation was attempted.`,
  );
  return {
    actor: actor.login,
    repository: repository.full_name,
    adminReadDenied: true,
    status: adminRead.status,
  };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!['--operation', '--issue', '--pr'].includes(key))
      throw new Error(`Unknown argument ${key}.`);
    args[key.slice(2)] = argv[++index] ?? '';
  }
  if (!['create-pr', 'integrate', 'verify-credential'].includes(args.operation))
    throw new Error(
      'Operation must be create-pr, integrate, or verify-credential.',
    );
  if (!/^[1-9][0-9]*$/.test(args.issue ?? ''))
    throw new Error('A valid --issue is required.');
  if (args.operation === 'integrate' && !/^[1-9][0-9]*$/.test(args.pr ?? ''))
    throw new Error('A valid --pr is required for integrate.');
  return {
    ...args,
    issue: Number(args.issue),
    pr: args.pr ? Number(args.pr) : null,
  };
}

export async function runIntegration({
  operation,
  issueNumber,
  pullNumber,
  token,
  repository,
  apiUrl,
  workerPolicy,
  fetchImpl = fetch,
  request = jsonApi({ token, repository, apiUrl }),
}) {
  const workerConfig = normalizeWorkerConfig(workerPolicy);
  if (operation === 'create-pr')
    return createPullRequest(request, { issueNumber, workerConfig, fetchImpl });
  if (operation === 'integrate')
    return integratePullRequest(request, {
      issueNumber,
      pullNumber,
      workerConfig,
    });
  if (operation === 'verify-credential')
    return verifyCredentialBoundary(request, issueNumber);
  throw new Error('Unsupported integration operation.');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const policy = JSON.parse(
    await readFile(
      new URL('./worker-integration-identities.json', import.meta.url),
      'utf8',
    ),
  );
  const result = await runIntegration({
    operation: args.operation,
    issueNumber: args.issue,
    pullNumber: args.pr,
    token: process.env.STELLAR_INTEGRATION_TOKEN,
    repository: process.env.GITHUB_REPOSITORY,
    apiUrl: process.env.GITHUB_API_URL,
    workerPolicy: policy,
  });
  console.log(JSON.stringify(result));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
