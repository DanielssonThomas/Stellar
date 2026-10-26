import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  dependenciesFromBody,
  inspectClaim,
  ownerLabel,
} from './issue-worktree.mjs';
import { loadIssue } from './manage-issue-worktree.mjs';
import { validateIssue } from './validate-issue.mjs';

const repository = process.env.GITHUB_REPOSITORY ?? 'DanielssonThomas/Stellar';
const transitions = {
  'status:ready': [],
  // Recovery path for an integrated issue whose status update was interrupted.
  'status:triage': ['status:ready', 'status:done'],
  'status:in-progress': ['status:blocked', 'status:review'],
  'status:blocked': ['status:ready'],
  'status:review': ['status:in-progress', 'status:done'],
};

function run(args, input) {
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    windowsHide: true,
    ...(input ? { input } : {}),
  });
  if (result.status !== 0)
    throw new Error(
      (result.stderr || result.stdout || 'GitHub CLI command failed').trim(),
    );
  return result.stdout.trim();
}

function argsFrom(argv) {
  const result = { positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value.startsWith('--')) result[value.slice(2)] = argv[++i];
    else result.positional.push(value);
  }
  return result;
}

function labelsOf(issue) {
  return (issue.labels ?? []).map((label) =>
    typeof label === 'string' ? label : label.name,
  );
}

export function validateFreshIssue(
  issue,
  worker,
  allowClosed = false,
  statusOverride = null,
) {
  const errors = [];
  const labels = labelsOf(issue);
  const owners = labels.filter(
    (label) => label.startsWith('owner:') || label.startsWith('worker:'),
  );
  if (issue.state !== 'OPEN' && !(allowClosed && issue.state === 'CLOSED'))
    errors.push('Issue is not open.');
  if (owners.length !== 1 || owners[0] !== ownerLabel(worker))
    errors.push(`Issue owner must be ${ownerLabel(worker)}.`);
  const validation = validateIssue({
    ...issue,
    labels: labels.map((label) =>
      label.startsWith('status:')
        ? allowClosed
          ? 'status:done'
          : (statusOverride ?? label)
        : label,
    ),
  });
  if (!validation.valid) errors.push(...validation.errors);
  const expected = dependenciesFromBody(issue.body);
  const native = (issue.dependencies ?? []).map((dependency) =>
    Number(dependency.number ?? dependency),
  );
  if (
    expected === null ||
    expected.length !== native.length ||
    expected.some((number) => !native.includes(number)) ||
    native.some((number) => !expected.includes(number))
  )
    errors.push('Issue body and native blocked-by dependencies do not match.');
  return { valid: errors.length === 0, errors };
}

export function validateStatusTransition({
  issue,
  worker,
  expected,
  next,
  comment = '',
  hasPullRequest = false,
  hasClaim = false,
  hasMergedPullRequest = false,
  hasActiveClaim = false,
}) {
  const errors = [];
  const validation = validateFreshIssue(
    issue,
    worker,
    next === 'status:done',
    next === 'status:ready' ? 'status:ready' : null,
  );
  if (!validation.valid) errors.push(...validation.errors);
  const status = labelsOf(issue).filter((label) => label.startsWith('status:'));
  if (status.length !== 1 || status[0] !== expected)
    errors.push(
      `Expected current status ${expected}; fetched ${status.join(', ') || 'none'}.`,
    );
  if (status.length !== 1 || status[0] !== expected)
    return { valid: false, errors };
  if (!transitions[expected]?.includes(next))
    errors.push(`Status transition ${expected} -> ${next} is not allowed.`);
  if (next === 'status:blocked') {
    for (const section of ['Blocker', 'Evidence', 'Attempts', 'Progress']) {
      if (!new RegExp(`^#{1,6}\\s+${section}\\s*$`, 'im').test(comment))
        errors.push(`Blocker report needs a ${section} section.`);
    }
  }
  if (next === 'status:review' && !hasPullRequest)
    errors.push(
      'A linked open pull request to the authorized target is required for review status.',
    );
  if (expected === 'status:review' && next === 'status:in-progress') {
    if (!hasPullRequest)
      errors.push(
        'An existing linked open PR is required to resume review rework.',
      );
    if (!hasClaim)
      errors.push(
        'An active issue worktree claim is required to resume implementation.',
      );
  }
  if (next === 'status:done') {
    if (issue.state !== 'CLOSED')
      errors.push('Close the issue only after its pull request is integrated.');
    if (!hasMergedPullRequest)
      errors.push(
        'A merged pull request to the authorized target is required for done status.',
      );
    if (hasActiveClaim)
      errors.push(
        'Release the local worktree claim before marking the issue done.',
      );
    const acceptance = issue.body
      .split(/\r?\n/)
      .slice(
        issue.body
          .split(/\r?\n/)
          .findIndex((line) =>
            /^#{1,6}\s+Acceptance criteria\s*$/i.test(line),
          ) + 1,
      )
      .join('\n')
      .split(/^#{1,6}\s+/m)[0];
    const criteria = acceptance.match(/^\s*-\s*\[[ xX]\]\s+\S.+$/gm) ?? [];
    if (
      !criteria.length ||
      criteria.some((item) => !/^\s*-\s*\[[xX]\]/.test(item))
    )
      errors.push(
        'Mark every acceptance criterion complete before setting done.',
      );
  }
  if (expected === 'status:triage' && next === 'status:ready') {
    for (const dependency of issue.dependencies ?? []) {
      if (dependency.state !== 'CLOSED' || dependency.status !== 'status:done')
        errors.push(`Dependency #${dependency.number} is unresolved.`);
    }
  }
  if (expected === 'status:blocked' && next === 'status:ready') {
    if (!/^#{1,6}\s+Resolution\s*$/im.test(comment))
      errors.push(
        'A blocked issue needs a Resolution section before returning to ready.',
      );
    for (const dependency of issue.dependencies ?? []) {
      if (dependency.state !== 'CLOSED' || dependency.status !== 'status:done')
        errors.push(`Dependency #${dependency.number} is unresolved.`);
    }
  }
  return { valid: errors.length === 0, errors };
}

function confirmAuthorizedBranch(issue) {
  const target = labelsOf(issue).find((label) => label.startsWith('target:'));
  if (!target) throw new Error('Issue target is missing.');
  const branch = target.slice('target:'.length);
  run(['api', `repos/${repository}/branches/${encodeURIComponent(branch)}`]);
  return branch;
}

function findLinkedPullRequest(issueNumber, targetBranch) {
  const prs = JSON.parse(
    run([
      'pr',
      'list',
      '--repo',
      repository,
      '--state',
      'open',
      '--json',
      'number,body,baseRefName',
    ]),
  );
  return prs.some(
    (pr) =>
      pr.baseRefName === targetBranch &&
      new RegExp(
        `(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${issueNumber}\\b`,
        'i',
      ).test(pr.body ?? ''),
  );
}

function findMergedPullRequest(issueNumber, targetBranch) {
  const prs = JSON.parse(
    run([
      'pr',
      'list',
      '--repo',
      repository,
      '--state',
      'merged',
      '--json',
      'number,body,baseRefName',
    ]),
  );
  return prs.some(
    (pr) =>
      pr.baseRefName === targetBranch &&
      new RegExp(
        `(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${issueNumber}\\b`,
        'i',
      ).test(pr.body ?? ''),
  );
}

export async function appendProgress({ issue, worker, comment, postComment }) {
  const check = validateFreshIssue(issue, worker);
  if (!check.valid)
    throw new Error(
      `Issue #${issue.number} cannot be updated: ${check.errors.join(' ')}`,
    );
  if (!comment?.trim()) throw new Error('Progress comment cannot be empty.');
  await postComment(issue.number, comment.trim());
}

export async function changeStatus({
  issue,
  worker,
  expected,
  next,
  comment = '',
  hasPullRequest,
  hasClaim,
  hasMergedPullRequest,
  hasActiveClaim,
  updateLabels,
  postComment,
  refetch,
}) {
  const validate = (current) =>
    validateStatusTransition({
      issue: current,
      worker,
      expected,
      next,
      comment,
      hasPullRequest,
      hasClaim,
      hasMergedPullRequest,
      hasActiveClaim,
    });
  const unchanged = (current) =>
    current.state === issue.state &&
    current.body === issue.body &&
    JSON.stringify(labelsOf(current).sort()) ===
      JSON.stringify(labelsOf(issue).sort()) &&
    JSON.stringify(current.dependencies ?? []) ===
      JSON.stringify(issue.dependencies ?? []);
  const fail = (errors) =>
    new Error(
      `Issue #${issue.number} status was not changed: ${errors.join(' ')}`,
    );
  const first = await refetch(issue.number);
  if (!unchanged(first))
    throw fail([
      'Issue changed since it was first fetched; re-fetch before retrying.',
    ]);
  let check = validate(first);
  if (!check.valid) throw fail(check.errors);
  if (comment.trim()) await postComment(issue.number, comment.trim());
  const current = await refetch(issue.number);
  if (!unchanged(current))
    throw fail([
      'Issue changed before the status update; the appended evidence remains.',
    ]);
  check = validate(current);
  if (!check.valid) throw fail(check.errors);
  const nextLabels = labelsOf(current)
    .filter((label) => !label.startsWith('status:'))
    .concat(next);
  await updateLabels(issue.number, nextLabels);
  const latest = await refetch(issue.number);
  const labels = labelsOf(latest);
  const finalValidation = validateFreshIssue(
    latest,
    worker,
    next === 'status:done',
  );
  const statuses = labels.filter((label) => label.startsWith('status:'));
  if (!finalValidation.valid || statuses.length !== 1 || statuses[0] !== next)
    throw new Error(
      `Issue #${issue.number} changed during the update. The status write was atomic; re-fetch and reconcile current labels.`,
    );
  return latest;
}

function cliUpdateLabels(issueNumber, labels) {
  run(
    [
      'api',
      '--method',
      'PATCH',
      `repos/${repository}/issues/${issueNumber}`,
      '--input',
      '-',
    ],
    JSON.stringify({ labels }),
  );
}

function cliPostComment(issueNumber, comment) {
  const result = spawnSync(
    'gh',
    [
      'issue',
      'comment',
      String(issueNumber),
      '--repo',
      repository,
      '--body',
      comment,
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  if (result.status !== 0)
    throw new Error(
      (result.stderr || result.stdout || 'Comment failed').trim(),
    );
}

export async function main(argv = process.argv.slice(2)) {
  const args = argsFrom(argv);
  const [command, rawNumber] = args.positional;
  const number = Number(rawNumber);
  if (
    !['comment', 'status'].includes(command) ||
    !Number.isInteger(number) ||
    !args.worker
  )
    throw new Error(
      'Usage: update-issue.mjs comment <issue> --worker <identity> --comment-file <path> | status <issue> --worker <identity> --expected <status> --status <status> [--comment-file <path>]',
    );
  const issue = loadIssue(number);
  confirmAuthorizedBranch(issue);
  const comment = args['comment-file']
    ? (await readFile(resolve(args['comment-file']), 'utf8')).replace(
        /^\uFEFF/,
        '',
      )
    : '';
  if (command === 'comment') {
    await appendProgress({
      issue,
      worker: args.worker,
      comment,
      postComment: cliPostComment,
    });
    process.stdout.write(`Recorded progress on issue #${number}.\n`);
    return;
  }
  if (!args.expected || !args.status)
    throw new Error('Status updates require --expected and --status.');
  const status = (value) =>
    value.startsWith('status:') ? value : `status:${value}`;
  const expected = status(args.expected);
  const next = status(args.status);
  const target = labelsOf(issue)
    .find((label) => label.startsWith('target:'))
    ?.slice('target:'.length);
  const hasPullRequest = findLinkedPullRequest(number, target);
  const hasMergedPullRequest =
    next === 'status:done' && findMergedPullRequest(number, target);
  const claim =
    expected === 'status:review' && next === 'status:in-progress'
      ? await inspectClaim(process.cwd(), number)
      : null;
  const hasClaim =
    claim?.state === 'active' && claim.worker === ownerLabel(args.worker);
  const finalClaim =
    next === 'status:done' ? await inspectClaim(process.cwd(), number) : null;
  await changeStatus({
    issue,
    worker: args.worker,
    expected,
    next,
    comment,
    hasPullRequest,
    hasClaim,
    hasMergedPullRequest,
    hasActiveClaim: finalClaim?.state === 'active',
    updateLabels: cliUpdateLabels,
    postComment: cliPostComment,
    refetch: loadIssue,
  });
  process.stdout.write(`Issue #${number} status is now ${next}.\n`);
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
