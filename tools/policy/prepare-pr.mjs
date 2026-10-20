import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspectClaim, ownerLabel } from './issue-worktree.mjs';
import { loadIssue } from './manage-issue-worktree.mjs';
import { validateFreshIssue } from './update-issue.mjs';
import { validateCommitMessage } from './validate-commit-message.mjs';

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

export function validatePrepareState({
  issue,
  worker,
  branch,
  status,
  claim,
  commits,
  worktreePath,
  now = Date.now(),
}) {
  const errors = [];
  const validation = validateFreshIssue(issue, worker);
  if (!validation.valid) errors.push(...validation.errors);
  const labels = (issue.labels ?? []).map((label) =>
    typeof label === 'string' ? label : label.name,
  );
  const target = labels.find((label) => label.startsWith('target:'))?.slice(7);
  if (
    !['status:in-progress', 'status:review'].some((label) =>
      labels.includes(label),
    )
  )
    errors.push('Issue must be in progress or already in review.');
  if (!target) errors.push('Issue target is missing.');
  if (!branch?.startsWith(`issue/${issue.number}-`))
    errors.push('Current branch is not the issue-specific branch.');
  if (claim?.state !== 'active' || claim.worker !== ownerLabel(worker))
    errors.push('An active claim owned by this worker is required.');
  if (
    claim &&
    (claim.issue !== issue.number ||
      claim.branch !== branch ||
      claim.target !== target)
  )
    errors.push(
      'The active claim does not match this issue branch and target.',
    );
  if (claim && Date.parse(claim.expiresAt) <= now)
    errors.push('The issue claim has expired.');
  if (
    claim &&
    worktreePath &&
    resolve(claim.worktreePath) !== resolve(worktreePath)
  )
    errors.push('Current directory does not match the claimed worktree.');
  if (status)
    errors.push(
      'Commit or discard working-tree changes before preparing a PR.',
    );
  if (!commits.length)
    errors.push('No issue commits exist above the authorized target.');
  for (const message of commits) {
    const error = validateCommitMessage(message);
    if (error) errors.push(error);
    const linked = message.match(/^\[#([1-9][0-9]*)\]/)?.[1];
    if (linked !== String(issue.number))
      errors.push(`Every commit must link issue #${issue.number}.`);
  }
  return { valid: errors.length === 0, errors, target };
}

export function parseCommitMessages(output) {
  return output
    .split('\0')
    .map((message) => message.trim())
    .filter(Boolean);
}

async function main(argv) {
  const [rawNumber, ...rest] = argv;
  const workerIndex = rest.indexOf('--worker');
  const worker = workerIndex >= 0 ? rest[workerIndex + 1] : undefined;
  const number = Number(rawNumber);
  if (!Number.isInteger(number) || number < 1 || !worker)
    throw new Error('Usage: prepare-pr.mjs <issue> --worker <identity>');
  const issue = loadIssue(number);
  const branch = git(['branch', '--show-current']);
  const status = git(['status', '--porcelain']);
  const claim = await inspectClaim(process.cwd(), number);
  const labels = issue.labels.map((label) => label.name);
  const target = labels.find((label) => label.startsWith('target:'))?.slice(7);
  if (!target) throw new Error('Issue target is missing.');
  execFileSync('git', ['fetch', '--quiet', 'origin', target]);
  const base = `origin/${target}`;
  const range = `${git(['merge-base', base, 'HEAD'])}..HEAD`;
  const commits = parseCommitMessages(git(['log', '--format=%B%x00', range]));
  const result = validatePrepareState({
    issue,
    worker,
    branch,
    status,
    claim,
    commits,
    worktreePath: process.cwd(),
  });
  if (!result.valid) throw new Error(result.errors.join('\n'));
  const changedFiles = git(['diff', '--name-only', `${base}...HEAD`])
    .split(/\r?\n/)
    .filter(Boolean);
  if (!changedFiles.length)
    throw new Error('The branch has no diff from its authorized target.');
  process.stdout.write(
    `${JSON.stringify({ issue: number, owner: ownerLabel(worker), target, branch, commits: commits.length, changedFiles }, null, 2)}\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
