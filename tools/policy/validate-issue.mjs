import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';

export const categories = {
  priority: [
    'priority:low',
    'priority:medium',
    'priority:high',
    'priority:critical',
  ],
  review: ['review:light', 'review:standard', 'review:critical'],
  target: ['target:develop'],
  type: [
    'type:feature',
    'type:bug',
    'type:chore',
    'type:refactor',
    'type:blocker',
    'type:epic',
  ],
  status: [
    'status:triage',
    'status:ready',
    'status:in-progress',
    'status:blocked',
    'status:review',
    'status:done',
  ],
};

const releaseTarget = /^target:release\/\d{4}\.(?:0[1-9]|1[0-2])$/;
const ownerLabel = /^(?:owner:(?:codex|maintainer)|worker:[a-z0-9][a-z0-9-]*)$/;
const configuredAuthorizedWorkers = new Set(
  JSON.parse(
    readFileSync(new URL('./authorized-workers.json', import.meta.url), 'utf8'),
  ),
);

function labelsOf(issue) {
  return issue.labels.map((label) =>
    typeof label === 'string' ? label : label.name,
  );
}

function section(body, name) {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) =>
    new RegExp(`^#{1,6}\\s+${name}\\s*$`, 'i').test(line),
  );
  if (start < 0) return '';
  const content = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line)) break;
    content.push(line);
  }
  return content.join('\n').trim();
}

export function validateIssue(
  issue,
  { authorizedWorkers = configuredAuthorizedWorkers } = {},
) {
  const labels = labelsOf(issue);
  const errors = [];
  const found = {};
  for (const [category, allowed] of Object.entries(categories)) {
    found[category] = labels.filter((label) =>
      label.startsWith(`${category}:`),
    );
    if (
      found[category].some(
        (label) =>
          !allowed.includes(label) &&
          !(category === 'target' && releaseTarget.test(label)),
      )
    ) {
      errors.push(`Invalid ${category} label.`);
    }
  }
  found.owner = labels.filter(
    (label) => label.startsWith('owner:') || label.startsWith('worker:'),
  );
  const statuses = found.status;
  const authorizedWorkerIds =
    authorizedWorkers instanceof Set
      ? authorizedWorkers
      : new Set(authorizedWorkers);
  for (const label of found.owner.filter((owner) =>
    owner.startsWith('worker:'),
  )) {
    if (!authorizedWorkerIds.has(label.slice('worker:'.length)))
      errors.push(`Worker ${label} is not authorized.`);
  }
  if (
    found.priority.includes('priority:critical') &&
    found.owner.some((label) => label.startsWith('worker:'))
  ) {
    errors.push('Critical priority must be owned by Codex or a maintainer.');
  }
  const isTriage = statuses.length === 1 && statuses[0] === 'status:triage';
  if (statuses.length > 1) errors.push('Use exactly one status label.');

  if (isTriage) return { valid: errors.length === 0, ready: false, errors };
  if (statuses.length !== 1)
    errors.push('Actionable issues require exactly one valid status label.');

  for (const category of ['priority', 'target', 'type', 'owner']) {
    if (found[category].length !== 1)
      errors.push(`Use exactly one ${category} label.`);
  }
  // Issue numbers through #102 predate this policy. Draft CLI validation has no number.
  if (!issue.number || issue.number > 102) {
    if (found.review.length !== 1)
      errors.push('Use exactly one review label for new actionable issues.');
  } else if (found.review.length > 1) {
    errors.push('Use at most one review label for historical issues.');
  }
  if (found.owner.some((label) => !ownerLabel.test(label)))
    errors.push('Use owner:codex, owner:maintainer, or worker:<profile-id>.');
  if (
    found.target.length === 1 &&
    !categories.target.includes(found.target[0]) &&
    !releaseTarget.test(found.target[0])
  ) {
    errors.push('Target must be develop or release/YYYY.MM.');
  }

  for (const heading of [
    'Objective',
    'Expected outcome',
    'Constraints',
    'Verification expectations',
  ]) {
    if (!section(issue.body ?? '', heading))
      errors.push(`Add a non-empty ${heading} section.`);
  }
  const acceptance = section(issue.body ?? '', 'Acceptance criteria');
  const acceptanceItems = acceptance.match(/^\s*-\s*\[[ xX]\]\s+\S.+$/gm) ?? [];
  if (isDone(issue)) {
    if (
      acceptanceItems.length === 0 ||
      acceptanceItems.some((item) => !/^\s*-\s*\[[xX]\]/.test(item))
    ) {
      errors.push('Mark every acceptance criterion complete before closing.');
    }
  } else if (!/^\s*-\s*\[ \]\s+\S.+/m.test(acceptance)) {
    errors.push('Add at least one observable unchecked acceptance criterion.');
  }
  const dependencies = section(issue.body ?? '', 'Dependencies');
  const dependencyIds = dependencies.match(/#\d+/g) ?? [];
  if (new Set(dependencyIds).size !== dependencyIds.length)
    errors.push('List each dependency only once.');
  if (
    !dependencies ||
    (!/^\s*(?:none|n\/a)\s*$/i.test(dependencies) && !/#\d+/.test(dependencies))
  ) {
    errors.push('Dependencies must say None or list issue IDs.');
  }
  if (
    issue.number &&
    dependencies
      .match(/#(\d+)/g)
      ?.some((id) => Number(id.slice(1)) === issue.number)
  ) {
    errors.push('An issue cannot depend on itself.');
  }

  return {
    valid: errors.length === 0,
    ready: found.status.includes('status:ready') && errors.length === 0,
    errors,
  };
}

async function api(path, method, token, apiUrl, body) {
  const response = await fetch(
    `${apiUrl}/repos/${process.env.GITHUB_REPOSITORY}${path}`,
    {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2026-03-10',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  );
  if (!response.ok && response.status !== 404)
    throw new Error(
      `GitHub API ${method} ${path} returned ${response.status}.`,
    );
  return response;
}

async function validateNativeDependencies(issue) {
  const body = section(issue.body ?? '', 'Dependencies');
  const expected = /^\s*(?:none|n\/a)\s*$/i.test(body)
    ? []
    : [...body.matchAll(/#(\d+)/g)].map((match) => Number(match[1]));
  if (!process.env.GITHUB_TOKEN || foundStatus(issue) === 'status:triage')
    return [];

  const token = process.env.GITHUB_TOKEN;
  const apiUrl = process.env.GITHUB_API_URL ?? 'https://api.github.com';
  const errors = [];
  if (new Set(expected).size !== expected.length)
    errors.push('List each dependency only once.');
  for (const number of expected) {
    const response = await api(`/issues/${number}`, 'GET', token, apiUrl);
    if (response.status === 404)
      errors.push(`Dependency #${number} does not exist in this repository.`);
    else if ((await response.json()).pull_request)
      errors.push(`Dependency #${number} is a pull request, not an issue.`);
  }
  const nativeResponse = await api(
    `/issues/${issue.number}/dependencies/blocked_by`,
    'GET',
    token,
    apiUrl,
  );
  if (nativeResponse.status === 404) {
    errors.push('GitHub could not read native issue dependencies.');
    return errors;
  }
  const native = (await nativeResponse.json()).map(
    (dependency) => dependency.number,
  );
  for (const number of expected) {
    if (!native.includes(number))
      errors.push(`Link #${number} as a native blocked-by dependency.`);
  }
  for (const number of native) {
    if (!expected.includes(number))
      errors.push(
        `Record native dependency #${number} in the Dependencies section.`,
      );
  }
  return errors;
}

async function validateTargetBranch(issue) {
  if (!process.env.GITHUB_TOKEN || foundStatus(issue) === 'status:triage')
    return [];
  const target = labelsOf(issue).find((label) => label.startsWith('target:'));
  if (!target) return [];
  const branch =
    target === 'target:develop' ? 'develop' : target.slice('target:'.length);
  const token = process.env.GITHUB_TOKEN;
  const apiUrl = process.env.GITHUB_API_URL ?? 'https://api.github.com';
  const response = await api(
    `/branches/${encodeURIComponent(branch)}`,
    'GET',
    token,
    apiUrl,
  );
  return response.status === 404
    ? [`Authorized target branch ${branch} does not exist.`]
    : [];
}

async function ensureTriageLabel(issue) {
  const token = process.env.GITHUB_TOKEN;
  const apiUrl = process.env.GITHUB_API_URL ?? 'https://api.github.com';
  const response = await api('/labels/status%3Atriage', 'GET', token, apiUrl);
  if (response.status === 404) {
    await api('/labels', 'POST', token, apiUrl, {
      name: 'status:triage',
      color: 'ededed',
      description: 'Incomplete or not ready for implementation',
    });
  }
}

function labelsForTriage(issue) {
  const labels = labelsOf(issue).filter(
    (label) =>
      !label.startsWith('status:') &&
      !(
        label === 'priority:critical' &&
        labelsOf(issue).some((value) => value.startsWith('worker:'))
      ),
  );
  return [...new Set([...labels, 'status:triage'])];
}

function sameLabels(left, right) {
  return (
    JSON.stringify(labelsOf(left).sort()) ===
    JSON.stringify(labelsOf(right).sort())
  );
}

export async function processIssueEvent({
  issueNumber,
  fetchIssue,
  updateLabels,
  validateCurrent,
  ensureTriage = ensureTriageLabel,
  maxAttempts = 3,
}) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const current = await fetchIssue(issueNumber);
    const result = await validateCurrent(current);
    if (result.errors.length === 0) {
      console.log(`Issue #${issueNumber} metadata is valid.`);
      return { issue: current, changed: false };
    }
    console.warn(
      `Issue #${issueNumber} is not ready: ${result.errors.join(' ')}`,
    );
    const desired = labelsForTriage(current);
    if (
      foundStatus(current) === 'status:triage' &&
      sameLabels(current, { labels: desired })
    )
      return { issue: current, changed: false };
    await ensureTriage(current);
    // Re-fetch immediately before replacing the complete label set. GitHub has
    // no label-set compare-and-swap, so this guarded read narrows the race and
    // the claim manager performs its own post-write reconciliation.
    const guarded = await fetchIssue(issueNumber);
    if (!sameLabels(current, guarded)) continue;
    await updateLabels(issueNumber, desired);
    const latest = await fetchIssue(issueNumber);
    const verified = await validateCurrent(latest);
    if (verified.errors.length === 0)
      return { issue: latest, changed: true, reconciled: true };
    if (labelsOf(latest).length && foundStatus(latest) === 'status:triage')
      return { issue: latest, changed: true, reconciled: false };
  }
  throw new Error(
    `Issue #${issueNumber} kept changing during policy reconciliation; no further label writes were attempted.`,
  );
}

async function fetchCurrentIssue(issueNumber) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is required to read issue state.');
  const apiUrl = process.env.GITHUB_API_URL ?? 'https://api.github.com';
  const response = await api(`/issues/${issueNumber}`, 'GET', token, apiUrl);
  return response.json();
}

async function updateCurrentLabels(issueNumber, labels) {
  const token = process.env.GITHUB_TOKEN;
  if (!token)
    throw new Error('GITHUB_TOKEN is required to update issue labels.');
  const apiUrl = process.env.GITHUB_API_URL ?? 'https://api.github.com';
  await api(`/issues/${issueNumber}`, 'PATCH', token, apiUrl, { labels });
}

function argsFrom(argv) {
  const values = { title: '', bodyFile: '', labels: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--title') values.title = argv[++index] ?? '';
    else if (arg === '--body-file') values.bodyFile = argv[++index] ?? '';
    else if (arg === '--labels') values.labels.push(argv[++index] ?? '');
  }
  return values;
}

async function main() {
  if (process.env.GITHUB_EVENT_PATH) {
    const event = JSON.parse(
      await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'),
    );
    const issueNumber = event.issue?.number;
    if (!issueNumber)
      throw new Error('The GitHub event does not contain an issue number.');
    await processIssueEvent({
      issueNumber,
      fetchIssue: fetchCurrentIssue,
      updateLabels: updateCurrentLabels,
      validateCurrent: async (issue) => {
        const result = validateIssue(issue);
        result.errors.push(
          ...(await validateNativeDependencies(issue)),
          ...(await validateTargetBranch(issue)),
        );
        result.ready = result.ready && result.errors.length === 0;
        if (!labelsOf(issue).some((label) => label.startsWith('status:')))
          result.errors.push('Issue has no status label.');
        return result;
      },
    });
    return;
  }

  const args = argsFrom(process.argv.slice(2));
  if (!args.title || !args.bodyFile || args.labels.length === 0) {
    throw new Error(
      'Usage: validate-issue --title <title> --body-file <path> --labels <label> [--labels <label> ...]',
    );
  }
  const result = validateIssue({
    title: args.title,
    body: await readFile(args.bodyFile, 'utf8'),
    labels: args.labels,
  });
  if (result.errors.length) throw new Error(result.errors.join('\n'));
  console.log(
    result.ready ? 'Issue is valid and ready.' : 'Issue is valid for triage.',
  );
}

function foundStatus(issue) {
  const statuses = labelsOf(issue).filter((label) =>
    label.startsWith('status:'),
  );
  return statuses.length === 1 ? statuses[0] : '';
}

function isDone(issue) {
  return labelsOf(issue).includes('status:done');
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
