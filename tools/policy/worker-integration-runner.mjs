import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateIssue } from './validate-issue.mjs';
import { captureIntegrationEvidence } from './integration-evidence.mjs';
import { readJson, readAll, issueContext } from './integration-github.mjs';
import {
  apiVersion,
  createGitHubRequest,
  normalizeWorkerConfig,
} from './integration-client.mjs';

function labelsOf(issue) {
  return (issue.labels ?? []).map((label) =>
    typeof label === 'string' ? label : (label?.name ?? ''),
  );
}

async function appendComment(request, issueNumber, comment) {
  await request(`/issues/${issueNumber}/comments`, {
    method: 'POST',
    body: { body: comment },
  });
}

async function replaceStatus(request, issue, expected, next, repository) {
  const fresh = await issueContext(request, issue.number, { repository });
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
  { issueNumber, workerConfig, fetchImpl, repository },
) {
  const issue = await issueContext(request, issueNumber, { repository });
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
    await replaceStatus(
      request,
      issue,
      'status:in-progress',
      'status:review',
      repository,
    );
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
  { issueNumber, pullNumber, workerConfig, repository, expectedEvidenceDigest },
) {
  const evidence = await captureIntegrationEvidence(request, {
    issueNumber,
    pullNumber,
    workerConfig,
    repository,
  });
  if (
    !evidence.decision.eligible ||
    (expectedEvidenceDigest && evidence.digest !== expectedEvidenceDigest)
  ) {
    if (expectedEvidenceDigest && evidence.digest !== expectedEvidenceDigest)
      evidence.decision = {
        ...evidence.decision,
        eligible: false,
        reasons: [
          ...evidence.decision.reasons,
          'integration-evidence-pin-mismatch',
        ],
      };
    await recordDenial(request, evidence);
    return { merged: false, reasons: evidence.decision.reasons };
  }
  const latest = await captureIntegrationEvidence(request, {
    issueNumber,
    pullNumber,
    workerConfig,
    repository,
  });
  if (!latest.decision.eligible || latest.digest !== evidence.digest) {
    const stale = {
      ...latest,
      decision: {
        ...latest.decision,
        eligible: false,
        reasons: [
          ...latest.decision.reasons,
          'integration-evidence-changed-before-merge',
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
  if (
    !['create-pr', 'inspect', 'integrate', 'verify-credential'].includes(
      args.operation,
    )
  )
    throw new Error(
      'Operation must be create-pr, inspect, integrate, or verify-credential.',
    );
  if (!/^[1-9][0-9]*$/.test(args.issue ?? ''))
    throw new Error('A valid --issue is required.');
  if (
    ['inspect', 'integrate'].includes(args.operation) &&
    !/^[1-9][0-9]*$/.test(args.pr ?? '')
  )
    throw new Error('A valid --pr is required for inspect or integrate.');
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
  expectedEvidenceDigest,
  request = createGitHubRequest({ token, repository, apiUrl }),
}) {
  if (
    expectedEvidenceDigest !== undefined &&
    !/^[a-f0-9]{64}$/.test(expectedEvidenceDigest)
  )
    throw new Error('Expected integration evidence must be a full digest.');
  const workerConfig = normalizeWorkerConfig(workerPolicy);
  if (operation === 'create-pr')
    return createPullRequest(request, {
      issueNumber,
      workerConfig,
      fetchImpl,
      repository,
    });
  if (operation === 'inspect')
    return captureIntegrationEvidence(request, {
      issueNumber,
      pullNumber,
      workerConfig,
      repository,
    });
  if (operation === 'integrate')
    return integratePullRequest(request, {
      issueNumber,
      pullNumber,
      workerConfig,
      repository,
      expectedEvidenceDigest,
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
