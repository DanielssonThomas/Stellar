import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { evaluateWorkerPullRequest } from './worker-integration-gate.mjs';
import { effectiveTier } from './ai-review.mjs';
import {
  issueContext,
  readAll,
  readCheckRuns,
  readJson,
  readReviewThreads,
} from './integration-github.mjs';
import { assessIntegrationProtection } from './integration-protection.mjs';
import {
  digest,
  isRevision,
  isText,
  requireValue,
} from './engineering-org/planning-evidence.mjs';

const positive = (value) => Number.isSafeInteger(value) && value > 0;
const nonnegative = (value) => Number.isSafeInteger(value) && value >= 0;
const detached = (value) => {
  digest(value);
  return JSON.parse(JSON.stringify(value));
};
const sorted = (values) =>
  [...values].sort((left, right) => digest(left).localeCompare(digest(right)));

function labels(issue) {
  requireValue(
    Array.isArray(issue.labels),
    'Issue label evidence is incomplete.',
  );
  const names = issue.labels.map((label) =>
    typeof label === 'string' ? label : label?.name,
  );
  requireValue(
    names.every(isText) && new Set(names).size === names.length,
    'Issue label evidence is malformed.',
  );
  return names.sort();
}

function issueFacts(issue) {
  return {
    id: issue.id,
    repositoryUrl: issue.repository_url,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: labels(issue),
    dependencies: issue.dependencies
      .map((dependency) => ({
        id: dependency.id,
        number: dependency.number,
        repositoryUrl: dependency.repository_url,
        state: dependency.state,
        labels: labels(dependency),
      }))
      .sort((a, b) => a.number - b.number),
  };
}

function actor(value) {
  requireValue(
    positive(value?.id) && isText(value.login),
    'GitHub principal evidence is incomplete.',
  );
  return { id: value.id, login: value.login };
}

function repo(value) {
  requireValue(
    positive(value?.id) &&
      isText(value.full_name) &&
      /^[\w.-]+\/[\w.-]+$/.test(value.full_name),
    'Repository identity evidence is incomplete.',
  );
  return { id: value.id, fullName: value.full_name };
}

function pullFacts(pull) {
  requireValue(
    isRevision(pull.head?.sha) &&
      isRevision(pull.base?.sha) &&
      isText(pull.head.ref) &&
      isText(pull.base.ref) &&
      typeof pull.head.repo?.fork === 'boolean' &&
      typeof pull.draft === 'boolean' &&
      typeof pull.body === 'string',
    'Pull request identity evidence is incomplete.',
  );
  return {
    number: pull.number,
    state: pull.state,
    draft: pull.draft,
    body: pull.body,
    head: {
      sha: pull.head.sha,
      ref: pull.head.ref,
      repo: { ...repo(pull.head.repo), fork: pull.head.repo.fork },
    },
    base: {
      sha: pull.base.sha,
      ref: pull.base.ref,
      repo: repo(pull.base.repo),
    },
    author: actor(pull.user),
    mergeable: pull.mergeable,
    mergeableState: pull.mergeable_state,
  };
}

function completeChanges(pull, commits, files) {
  requireValue(
    positive(pull.commits) &&
      pull.commits <= 250 &&
      commits.length === pull.commits &&
      positive(pull.changed_files) &&
      files.length === pull.changed_files,
    'Commit or changed-file evidence is incomplete or exceeds its bound.',
  );
  requireValue(
    new Set(commits.map((commit) => commit.sha)).size === commits.length &&
      new Set(files.map((file) => file.filename)).size === files.length,
    'Commit or changed-file evidence is duplicated.',
  );
  requireValue(
    commits.every(
      (commit) =>
        isRevision(commit.sha) &&
        isText(commit.commit?.message) &&
        Array.isArray(commit.parents) &&
        commit.parents.every((parent) => isRevision(parent.sha)),
    ),
    'Commit evidence is malformed.',
  );
  requireValue(
    files.every(
      (file) =>
        isRevision(file.sha) &&
        isText(file.filename) &&
        isText(file.status) &&
        [file.additions, file.deletions, file.changes].every(nonnegative),
    ),
    'Changed-file evidence is malformed.',
  );
  requireValue(
    commits.at(-1).sha === pull.head.sha,
    'Commit list does not end at the exact PR head.',
  );
  return {
    commits: commits.map((commit) => ({
      sha: commit.sha,
      message: commit.commit.message,
      parents: commit.parents.map((parent) => parent.sha),
      author: commit.author ? actor(commit.author) : null,
      committer: commit.committer ? actor(commit.committer) : null,
    })),
    files: files
      .map((file) => ({
        sha: file.sha,
        filename: file.filename,
        status: file.status,
        previousFilename: file.previous_filename ?? null,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
      }))
      .sort((a, b) => a.filename.localeCompare(b.filename)),
  };
}

function checkFacts(checks) {
  requireValue(
    checks.every(
      (check) =>
        isText(check.name) &&
        isRevision(check.head_sha) &&
        isText(check.status) &&
        (check.conclusion === null || isText(check.conclusion)) &&
        positive(check.app?.id) &&
        isText(check.app.slug),
    ),
    'Check run source or state evidence is malformed.',
  );
  return checks
    .map((check) => ({
      id: check.id,
      name: check.name,
      headSha: check.head_sha,
      status: check.status,
      conclusion: check.conclusion,
      app: { id: check.app.id, slug: check.app.slug },
    }))
    .sort((a, b) => a.id - b.id);
}

function codeownersFacts(value) {
  requireValue(
    value?.type === 'file' &&
      value.path === '.github/CODEOWNERS' &&
      value.encoding === 'base64' &&
      isRevision(value.sha) &&
      typeof value.content === 'string',
    'Exact-target CODEOWNERS evidence is incomplete.',
  );
  const encoded = value.content.replace(/\s/g, '');
  const bytes = Buffer.from(encoded, 'base64');
  requireValue(
    bytes.toString('base64') === encoded,
    'CODEOWNERS encoding is invalid.',
  );
  requireValue(
    createHash('sha1')
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest('hex') === value.sha,
    'CODEOWNERS blob identity does not match its content.',
  );
  return {
    blobSha: value.sha,
    content: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
  };
}

export async function captureIntegrationEvidence(
  request,
  { issueNumber, pullNumber, workerConfig, repository },
) {
  requireValue(
    typeof request === 'function' &&
      positive(issueNumber) &&
      positive(pullNumber) &&
      isText(repository) &&
      /^[\w.-]+\/[\w.-]+$/.test(repository),
    'Integration evidence requires trusted repository and issue identities.',
  );
  const workers = workerConfig?.workers ?? workerConfig?.workersMap;
  requireValue(
    Array.isArray(workerConfig?.ids) && workers instanceof Map,
    'Trusted worker mappings are required.',
  );
  const [issue, pull, repositoryInfo, principal, target] = await Promise.all([
    issueContext(request, issueNumber, { repository }),
    readJson(request, `/pulls/${pullNumber}`),
    readJson(request, ''),
    readJson(request, '/@root/user'),
    readJson(request, '/branches/develop'),
  ]);
  const repositoryFacts = repo(repositoryInfo);
  requireValue(
    repositoryFacts.fullName.toLowerCase() === repository.toLowerCase() &&
      pull?.number === pullNumber &&
      target?.name === 'develop' &&
      isRevision(target.commit?.sha) &&
      typeof target.protected === 'boolean',
    'Repository, pull or target identity does not match capture.',
  );
  const pullEvidence = pullFacts(pull);
  const [commits, files, checks, owners, branchRules, classicProtection] =
    await Promise.all([
      readAll(request, `/pulls/${pullNumber}/commits`),
      readAll(request, `/pulls/${pullNumber}/files`),
      readCheckRuns(request, pull.head.sha),
      readJson(
        request,
        `/contents/.github/CODEOWNERS?ref=${target.commit.sha}`,
      ),
      readAll(request, '/rules/branches/develop'),
      readJson(request, '/branches/develop/protection'),
    ]);
  const ids = [...new Set(branchRules.map((rule) => rule.ruleset_id))].sort(
    (a, b) => a - b,
  );
  requireValue(
    ids.every(positive) && ids.length <= 32,
    'Ruleset identities are malformed or exceed their bound.',
  );
  const rulesets = await Promise.all(
    ids.map((id) => readJson(request, `/rulesets/${id}?includes_parents=true`)),
  );
  const protection = assessIntegrationProtection(
    branchRules,
    rulesets,
    classicProtection,
  );
  const codeowners = codeownersFacts(owners);
  const changes = completeChanges(pull, commits, files);
  const checkEvidence = checkFacts(checks);
  const threads = protection.threadsRequired
    ? await readReviewThreads(request, {
        repository,
        repositoryId: repositoryFacts.id,
        pullNumber,
        headSha: pull.head.sha,
      })
    : [];
  const workerId = labels(issue)
    .find((label) => label.startsWith('worker:'))
    ?.slice(7);
  const worker = workers.get(workerId);
  const policy = {
    reviewTier: effectiveTier(issue, files, {
      expectedCount: pull.changed_files,
    }),
    codeowners,
    branchRules: sorted(branchRules),
    rulesets: sorted(rulesets),
    classicProtection,
    requiredChecks: protection.requiredChecks,
    threadsRequired: protection.threadsRequired,
    repositoryMerge: {
      archived: repositoryInfo.archived ?? null,
      disabled: repositoryInfo.disabled ?? null,
      allowSquashMerge: repositoryInfo.allow_squash_merge ?? null,
    },
    workerIdentity: {
      id: worker?.id ?? null,
      forkFullName: worker?.forkFullName ?? null,
      pullRequestActor: worker?.pullRequestActor ?? null,
      authorizedWorkerIds: [...workerConfig.ids].sort(),
    },
  };
  const facts = detached({
    schemaVersion: 1,
    repository: repositoryFacts,
    actor: actor(principal),
    issue: issueFacts(issue),
    pull: pullEvidence,
    target: {
      name: 'develop',
      sha: target.commit.sha,
      protected: target.protected,
    },
    ...changes,
    checks: checkEvidence,
    policy,
    reviewThreads: threads,
  });
  const baseDecision = evaluateWorkerPullRequest({
    issue,
    pullRequest: {
      number: pull.number,
      state: pull.state,
      isDraft: pull.draft,
      body: pull.body,
      baseRefName: pull.base.ref,
      headRefName: pull.head.ref,
      headRepoFullName: pull.head.repo.full_name,
      authorLogin: pull.user.login,
      headSha: pull.head.sha,
    },
    worker,
    integrationActor: principal.login,
    authorizedWorkerIds: workerConfig.ids,
    commits: changes.commits,
    checks: checkEvidence,
    changedFiles: files,
    codeowners: codeowners.content,
    requiredChecks: protection.requiredChecks.map((check) => check.name),
    allowedTargets: ['develop'],
  });
  const reasons = new Set([...baseDecision.reasons, ...protection.reasons]);
  if (!['light', 'standard'].includes(policy.reviewTier))
    reasons.add('integration-risk-requires-critical-review');
  if (
    pullEvidence.base.repo.id !== repositoryFacts.id ||
    pullEvidence.base.repo.fullName.toLowerCase() !==
      repository.toLowerCase() ||
    pullEvidence.head.repo.fork !== true
  )
    reasons.add('pull-repository-identity-mismatch');
  if (
    !target.protected ||
    pull.mergeable !== true ||
    pull.mergeable_state !== 'clean'
  )
    reasons.add('protected-merge-not-ready');
  if (pull.base.sha !== target.commit.sha)
    reasons.add('target-revision-changed');
  if (
    repositoryInfo.archived !== false ||
    repositoryInfo.disabled !== false ||
    repositoryInfo.allow_squash_merge !== true
  )
    reasons.add('repository-merge-policy-unavailable');
  for (const required of protection.requiredChecks) {
    const matching = checkEvidence.filter(
      (check) =>
        check.name === required.name && check.app.id === required.appId,
    );
    if (
      !matching.length ||
      matching.some(
        (check) =>
          check.headSha !== pull.head.sha ||
          check.status !== 'completed' ||
          check.conclusion !== 'success',
      )
    )
      reasons.add('required-check-source-state-or-head-invalid');
  }
  if (threads.some((thread) => !thread.isResolved))
    reasons.add('review-threads-unresolved');
  const decision = {
    ...baseDecision,
    eligible: reasons.size === 0,
    reasons: [...reasons].sort(),
  };
  return {
    issue: detached(issue),
    pull: detached(pull),
    baseSha: target.commit.sha,
    decision,
    facts,
    digest: digest(facts),
    policyDigest: digest(policy),
  };
}
