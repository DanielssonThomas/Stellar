import { validateIssue } from './validate-issue.mjs';
import { validateCommitMessage } from './validate-commit-message.mjs';

const section = (body, heading) => {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) =>
    new RegExp('^#{1,6}\\s+' + heading + '\\s*$', 'i').test(line),
  );
  if (start < 0) return '';
  const content = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line)) break;
    content.push(line);
  }
  return content.join('\n').trim();
};

function labelsOf(issue) {
  return (issue.labels ?? []).map((label) =>
    typeof label === 'string'
      ? label
      : label && typeof label === 'object'
        ? label.name
        : '',
  );
}

function normalizePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\')) return null;
  const path = value.replace(/^\.\//, '');
  if (
    path.startsWith('/') ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  )
    return null;
  return path;
}

export function parseIntegrationScope(body) {
  if (typeof body !== 'string')
    return { risk: null, allowedFiles: [], valid: false };
  const headings = body.match(/^#{1,6}\s+Agent integration scope\s*$/gim) ?? [];
  if (headings.length !== 1)
    return { risk: null, allowedFiles: [], valid: false };
  const contents = section(body, 'Agent integration scope');
  const riskLines = contents.match(/^Risk:\s*(\S+)\s*$/gim) ?? [];
  const allowedSections = contents.match(/^Allowed files:\s*$/gim) ?? [];
  const fileSection = contents.match(
    /^Allowed files:\s*\r?\n([\s\S]*)$/im,
  )?.[1];
  const fileLines = (fileSection ?? '')
    .split(/\r?\n/)
    .filter((line) => line.trim());
  const allowedFiles = fileLines
    .map((line) => line.match(/^\s*-\s+`([^`]+)`\s*$/)?.[1])
    .filter(Boolean);
  const risk = riskLines[0]?.match(/^Risk:\s*(\S+)\s*$/i)?.[1]?.toLowerCase();
  return {
    risk,
    allowedFiles,
    valid:
      riskLines.length === 1 &&
      allowedSections.length === 1 &&
      fileLines.length > 0 &&
      allowedFiles.length === fileLines.length,
  };
}

export function parseProtectedCodeowners(content) {
  if (typeof content !== 'string' || !content.trim())
    return { patterns: [], valid: false };
  const patterns = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const [rawPattern, ...owners] = line.split(/\s+/);
    if (
      !rawPattern ||
      owners.length === 0 ||
      !owners.some((owner) => owner.startsWith('@'))
    )
      return { patterns: [], valid: false };
    // The current repository CODEOWNERS uses literal root paths only. Unknown
    // glob syntax fails closed until the matcher is deliberately extended.
    if (
      ['!', '*', '?', '[', ']', '\\'].some((character) =>
        rawPattern.includes(character),
      )
    )
      return { patterns: [], valid: false };
    const pattern = rawPattern.replace(/^\/+/, '');
    if (!pattern || pattern.split('/').includes('..'))
      return { patterns: [], valid: false };
    patterns.push({ path: pattern, directory: pattern.endsWith('/') });
  }
  return { patterns, valid: patterns.length > 0 };
}

function pathIsProtected(path, patterns) {
  return patterns.some(({ path: pattern, directory }) =>
    directory ? path.startsWith(pattern) : path === pattern,
  );
}

function dependencyNumbers(body) {
  if (typeof body !== 'string') return null;
  const text = section(body, 'Dependencies');
  if (/^\s*(?:none|n\/a)\s*$/i.test(text)) return [];
  return [...text.matchAll(/#([1-9][0-9]*)/g)].map((match) => Number(match[1]));
}

function addReason(reasons, code) {
  reasons.add(code);
}

/**
 * Evaluate trusted metadata for a worker PR. This function performs no network,
 * process, filesystem, or merge operation. Callers must obtain metadata and
 * policy inputs from trusted sources on the authorized base branch.
 */
export function evaluateWorkerPullRequest({
  issue,
  pullRequest,
  worker,
  authorizedWorkerIds,
  commits,
  checks,
  changedFiles,
  codeowners,
  requiredChecks = ['verify'],
  allowedTargets = ['develop'],
}) {
  const reasons = new Set();
  const labels = labelsOf(issue ?? {});
  const issueNumber = Number(issue?.number);
  const owner =
    typeof worker?.id === 'string' ? 'worker:' + worker.id : 'worker:';
  const target = labels.find((label) => label.startsWith('target:'))?.slice(7);
  const headSha = pullRequest?.headSha;

  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1)
    addReason(reasons, 'invalid-issue-number');
  let validation = { valid: false };
  if (issue && Array.isArray(issue.labels)) {
    try {
      validation = validateIssue(issue, {
        authorizedWorkers: authorizedWorkerIds ?? [],
      });
    } catch {
      validation = { valid: false };
    }
  }
  if (!validation.valid) addReason(reasons, 'invalid-issue-metadata');
  if (String(issue?.state ?? '').toUpperCase() !== 'OPEN')
    addReason(reasons, 'issue-not-open');
  if (!labels.includes(owner)) addReason(reasons, 'issue-owner-mismatch');
  if (!labels.includes('status:review'))
    addReason(reasons, 'issue-not-in-review');
  if (!labels.includes('agent:automerge'))
    addReason(reasons, 'issue-not-approved-for-integration');
  if (!Array.isArray(allowedTargets) || !allowedTargets.includes(target))
    addReason(reasons, 'issue-target-not-allowed');

  const expectedDependencies = dependencyNumbers(issue?.body);
  const dependencies = Array.isArray(issue?.dependencies)
    ? issue.dependencies
    : [];
  const nativeDependencies = dependencies.map((item) =>
    Number(item && typeof item === 'object' ? item.number : item),
  );
  if (
    expectedDependencies === null ||
    !Array.isArray(issue?.dependencies) ||
    expectedDependencies.length !== nativeDependencies.length ||
    expectedDependencies.some(
      (number) => !nativeDependencies.includes(number),
    ) ||
    nativeDependencies.some((number) => !expectedDependencies.includes(number))
  ) {
    addReason(reasons, 'dependency-record-mismatch');
  }
  if (
    dependencies.some(
      (dependency) =>
        !dependency ||
        typeof dependency !== 'object' ||
        String(dependency.state ?? '').toUpperCase() !== 'CLOSED' ||
        !Array.isArray(dependency.labels) ||
        !dependency.labels.some(
          (label) =>
            (typeof label === 'string'
              ? label
              : label && typeof label === 'object'
                ? label.name
                : '') === 'status:done',
        ),
    )
  ) {
    addReason(reasons, 'unresolved-dependency');
  }

  const prBody = pullRequest?.body ?? '';
  const issueLink = new RegExp(
    '(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#' + issueNumber + '\\b',
    'i',
  );
  if (
    String(pullRequest?.state ?? '').toUpperCase() !== 'OPEN' ||
    pullRequest?.isDraft !== false ||
    !Number.isSafeInteger(Number(pullRequest?.number)) ||
    Number(pullRequest?.number) < 1
  ) {
    addReason(reasons, 'pull-request-not-open-ready');
  }
  if (
    !/^[a-f0-9]{40}$/i.test(headSha ?? '') ||
    pullRequest?.baseRefName !== target
  )
    addReason(reasons, 'pull-request-target-or-head-invalid');
  if (
    typeof issueNumber === 'number' &&
    !new RegExp(issueLink.source, issueLink.flags).test(prBody)
  ) {
    addReason(reasons, 'pull-request-does-not-link-issue');
  }
  if (
    !String(pullRequest?.headRefName ?? '').startsWith(
      'issue/' + issueNumber + '-',
    )
  )
    addReason(reasons, 'issue-branch-mismatch');
  const headRepoFullName = pullRequest?.headRepoFullName;
  if (
    !worker?.forkFullName ||
    typeof headRepoFullName !== 'string' ||
    typeof worker.forkFullName !== 'string' ||
    headRepoFullName.toLowerCase() !== worker.forkFullName.toLowerCase()
  ) {
    addReason(reasons, 'worker-fork-mismatch');
  }
  const authorLogin = pullRequest?.authorLogin;
  if (
    !worker?.pullRequestActor ||
    typeof authorLogin !== 'string' ||
    typeof worker.pullRequestActor !== 'string' ||
    authorLogin.toLowerCase() !== worker.pullRequestActor.toLowerCase()
  ) {
    addReason(reasons, 'worker-identity-mismatch');
  }

  const parsedScope = parseIntegrationScope(issue?.body ?? '');
  const normalizedAllowed = parsedScope.allowedFiles.map(normalizePath);
  if (
    !parsedScope.valid ||
    parsedScope.risk !== 'low' ||
    normalizedAllowed.length === 0 ||
    normalizedAllowed.some(
      (path, index) =>
        !path ||
        ['*', '?', '[', ']'].some((character) =>
          parsedScope.allowedFiles[index].includes(character),
        ),
    ) ||
    new Set(normalizedAllowed).size !== normalizedAllowed.length
  ) {
    addReason(reasons, 'trusted-low-risk-scope-invalid');
  }

  const normalizedChanged = Array.isArray(changedFiles)
    ? changedFiles.map(normalizePath)
    : [];
  if (
    normalizedChanged.length === 0 ||
    normalizedChanged.some((path) => !path) ||
    new Set(normalizedChanged).size !== normalizedChanged.length
  ) {
    addReason(reasons, 'changed-file-list-invalid');
  }
  for (const path of normalizedChanged.filter(Boolean)) {
    if (!normalizedAllowed.includes(path))
      addReason(reasons, 'changed-file-outside-trusted-scope');
  }
  const protectedPolicy = parseProtectedCodeowners(codeowners);
  if (!protectedPolicy.valid)
    addReason(reasons, 'protected-path-policy-invalid');
  else if (
    normalizedChanged.some(
      (path) => path && pathIsProtected(path, protectedPolicy.patterns),
    )
  ) {
    addReason(reasons, 'protected-path-changed');
  }

  if (!Array.isArray(commits) || commits.length === 0) {
    addReason(reasons, 'commit-list-invalid');
  } else {
    for (const commit of commits) {
      const message = typeof commit === 'string' ? commit : commit?.message;
      if (
        !message ||
        validateCommitMessage(message) ||
        message.match(/^\[#([1-9][0-9]*)\]/)?.[1] !== String(issueNumber)
      ) {
        addReason(reasons, 'issue-commit-invalid');
      }
    }
  }

  if (
    !Array.isArray(requiredChecks) ||
    requiredChecks.length === 0 ||
    !requiredChecks.includes('verify')
  )
    addReason(reasons, 'required-check-policy-invalid');
  else {
    for (const name of requiredChecks) {
      const matching = Array.isArray(checks)
        ? checks.filter(
            (check) =>
              check && typeof check === 'object' && check.name === name,
          )
        : [];
      if (
        !matching.some(
          (check) =>
            check.headSha === headSha && check.conclusion === 'success',
        ) ||
        matching.some(
          (check) =>
            check.headSha === headSha && check.conclusion !== 'success',
        )
      ) {
        addReason(reasons, 'required-check-missing-failed-or-stale');
      }
    }
  }

  const denialReasons = [...reasons].sort();
  return {
    eligible: denialReasons.length === 0,
    issue: Number.isSafeInteger(issueNumber) ? issueNumber : null,
    pullRequest: Number(pullRequest?.number) || null,
    headSha: typeof headSha === 'string' ? headSha : null,
    reasons: denialReasons,
  };
}
