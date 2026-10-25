import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  claimWorktree,
  inspectClaim,
  ownerLabel,
  releaseClaim,
  transferClaim,
} from './issue-worktree.mjs';
import { validateIssue } from './validate-issue.mjs';

const repository = process.env.GITHUB_REPOSITORY ?? 'DanielssonThomas/Stellar';

function run(command, args, cwd, input) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    ...(input ? { input } : {}),
  });
  if (result.status !== 0)
    throw new Error(
      (result.stderr || result.stdout || `${command} failed`).trim(),
    );
  return result.stdout.trim();
}

function options(argv) {
  const result = { positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value.startsWith('--')) result.positional.push(value);
    else result[value.slice(2)] = argv[++i];
  }
  return result;
}

export function loadIssue(number) {
  const issue = JSON.parse(
    run(
      'gh',
      [
        'issue',
        'view',
        String(number),
        '--repo',
        repository,
        '--json',
        'number,title,body,state,labels',
      ],
      process.cwd(),
    ),
  );
  const native = JSON.parse(
    run(
      'gh',
      ['api', `repos/${repository}/issues/${number}/dependencies/blocked_by`],
      process.cwd(),
    ),
  );
  issue.dependencies = native.map((dependency) => {
    const data = JSON.parse(
      run(
        'gh',
        [
          'issue',
          'view',
          String(dependency.number),
          '--repo',
          repository,
          '--json',
          'number,state,labels',
        ],
        process.cwd(),
      ),
    );
    const status = data.labels.find((label) =>
      label.name.startsWith('status:'),
    )?.name;
    return { number: data.number, state: data.state, status };
  });
  return issue;
}

function issueLabels(issue) {
  return issue.labels.map((label) =>
    typeof label === 'string' ? label : label.name,
  );
}

function updateIssueLabels(number, labels) {
  run(
    'gh',
    [
      'api',
      '--method',
      'PATCH',
      `repos/${repository}/issues/${number}`,
      '--input',
      '-',
    ],
    process.cwd(),
    JSON.stringify({ labels }),
  );
}

export async function reconcileClaimStatus({
  issueNumber,
  worker,
  resumed,
  reviewPr = null,
  fetchReview = null,
  fetchIssue = loadIssue,
  updateLabels = updateIssueLabels,
  maxAttempts = 3,
}) {
  const owner = ownerLabel(worker);
  const confirmReview = async () => {
    if (!reviewPr) return;
    if (typeof fetchReview !== 'function')
      throw new Error('A trusted review PR fetch is required.');
    const freshPr = await fetchReview(reviewPr.number);
    const link = new RegExp(
      `(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${issueNumber}\\b`,
      'i',
    );
    if (
      freshPr.state !== 'OPEN' ||
      freshPr.headRefOid !== reviewPr.headRefOid ||
      freshPr.headRefName !== reviewPr.headRefName ||
      freshPr.baseRefName !== reviewPr.baseRefName ||
      !link.test(freshPr.body ?? '')
    )
      throw new Error('Review PR changed; claim is preserved for recovery.');
  };
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const current = await fetchIssue(issueNumber);
    const labels = issueLabels(current);
    if (!labels.includes(owner))
      throw new Error(
        `Issue #${issueNumber} ownership changed; the worktree was preserved.`,
      );
    const statuses = labels.filter((label) => label.startsWith('status:'));
    if (
      statuses.length !== 1 ||
      ![
        'status:ready',
        'status:in-progress',
        'status:triage',
        ...(reviewPr ? ['status:review'] : []),
      ].includes(statuses[0])
    )
      throw new Error(
        `Issue #${issueNumber} status changed; the worktree was preserved.`,
      );
    if (statuses[0] === 'status:triage' && !resumed)
      throw new Error(
        `Issue #${issueNumber} is in triage without a recoverable active claim.`,
      );
    const policyIssue =
      statuses[0] === 'status:triage'
        ? {
            ...current,
            labels: labels.map((label) =>
              label === statuses[0] ? 'status:ready' : label,
            ),
          }
        : current;
    const policy = validateIssue(policyIssue);
    if (!policy.valid)
      throw new Error(
        `Issue #${issueNumber} metadata is invalid: ${policy.errors.join(' ')}`,
      );
    if (statuses[0] === 'status:in-progress') {
      await confirmReview();
      return current;
    }
    await confirmReview();
    const guarded = await fetchIssue(issueNumber);
    if (
      JSON.stringify(issueLabels(current).sort()) !==
      JSON.stringify(issueLabels(guarded).sort())
    )
      continue;
    const nextLabels = labels
      .filter((label) => !label.startsWith('status:'))
      .concat('status:in-progress');
    await updateLabels(issueNumber, nextLabels);
    const latest = await fetchIssue(issueNumber);
    const latestLabels = issueLabels(latest);
    const latestStatuses = latestLabels.filter((label) =>
      label.startsWith('status:'),
    );
    if (
      latestLabels.includes(owner) &&
      latestStatuses.length === 1 &&
      latestStatuses[0] === 'status:in-progress'
    ) {
      await confirmReview();
      return latest;
    }
    if (!latestLabels.includes(owner))
      throw new Error(
        `Issue #${issueNumber} ownership changed after the status write; inspect the preserved claim.`,
      );
    // A concurrent issue-policy reconciliation can still win after the guard.
    // Retry only when the same owner remains in triage and this is a resumed claim.
    if (
      latestStatuses.length !== 1 ||
      latestStatuses[0] !== 'status:triage' ||
      !resumed
    )
      throw new Error(
        `Issue #${issueNumber} changed during the status write; inspect the preserved claim.`,
      );
  }
  throw new Error(
    `Issue #${issueNumber} kept changing; claim status was not reconciled after ${maxAttempts} guarded attempts.`,
  );
}

function fetchTarget(repoRoot, target) {
  run(
    'git',
    [
      'fetch',
      '--quiet',
      'origin',
      `refs/heads/${target}:refs/remotes/origin/${target}`,
    ],
    repoRoot,
  );
}

function loadOpenReviewPr(number, target) {
  const prs = JSON.parse(
    run(
      'gh',
      [
        'pr',
        'list',
        '--repo',
        repository,
        '--state',
        'open',
        '--limit',
        '100',
        '--json',
        'number,body,state,baseRefName,headRefName,headRefOid',
      ],
      process.cwd(),
    ),
  ).filter(
    (pr) =>
      pr.baseRefName === target &&
      new RegExp(
        `(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${number}\\b`,
        'i',
      ).test(pr.body ?? ''),
  );
  if (prs.length !== 1)
    throw new Error(
      'Review resume requires exactly one linked open PR to the authorized target.',
    );
  return prs[0];
}

function fetchReviewPr(number) {
  return JSON.parse(
    run(
      'gh',
      [
        'pr',
        'view',
        String(number),
        '--repo',
        repository,
        '--json',
        'number,body,state,baseRefName,headRefName,headRefOid',
      ],
      process.cwd(),
    ),
  );
}

function usage() {
  throw new Error(
    [
      'Usage:',
      '  manage-issue-worktree.mjs claim <issue> --worker <codex|maintainer|profile-id> --session-id <stable-session-id>',
      '  manage-issue-worktree.mjs resume-review <issue> --worker <identity> --session-id <stable-session-id>',
      '  manage-issue-worktree.mjs inspect <issue>',
      '  manage-issue-worktree.mjs release <issue> --worker <identity> --session-id <stable-session-id>',
      '  manage-issue-worktree.mjs handoff <issue> --from <identity> --to <identity> --reason <text> [--session-id <id>]',
    ].join('\n'),
  );
}

export async function main(argv = process.argv.slice(2)) {
  const args = options(argv);
  const [command, rawNumber] = args.positional;
  const number = Number(rawNumber);
  if (!command || !Number.isInteger(number) || number < 1) usage();
  const repoRoot = run('git', ['rev-parse', '--show-toplevel'], process.cwd());

  if (command === 'inspect') {
    const result = await inspectClaim(repoRoot, number);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }
  if (command === 'release') {
    if (!args.worker || !args['session-id']) usage();
    const result = await releaseClaim({
      repoRoot,
      issueNumber: number,
      worker: args.worker,
      sessionId: args['session-id'],
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }
  if (command === 'claim') {
    if (!args.worker || !args['session-id']) usage();
    const issue = loadIssue(number);
    const target = issue.labels
      .find((label) => label.name.startsWith('target:'))
      ?.name.slice('target:'.length);
    if (!target) throw new Error(`Issue #${number} has no target label.`);
    fetchTarget(repoRoot, target);
    const result = await claimWorktree({
      repoRoot,
      issue,
      worker: args.worker,
      sessionId: args['session-id'],
      targetBranch: target,
    });
    await reconcileClaimStatus({
      issueNumber: number,
      worker: args.worker,
      resumed: Boolean(result.resumed),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }
  if (command === 'resume-review') {
    if (!args.worker || !args['session-id']) usage();
    const issue = loadIssue(number);
    if (!issueLabels(issue).includes('status:review'))
      throw new Error('Only a review-stage issue can resume PR rework.');
    const target = issueLabels(issue)
      .find((label) => label.startsWith('target:'))
      ?.slice(7);
    if (!target) throw new Error('Issue target is missing.');
    const reviewPr = loadOpenReviewPr(number, target);
    fetchTarget(repoRoot, target);
    const result = await claimWorktree({
      repoRoot,
      issue,
      worker: args.worker,
      sessionId: args['session-id'],
      targetBranch: target,
      reviewPr,
    });
    await reconcileClaimStatus({
      issueNumber: number,
      worker: args.worker,
      resumed: Boolean(result.resumed),
      reviewPr,
      fetchReview: fetchReviewPr,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }
  if (command === 'handoff') {
    if (!args.from || !args.to || !args.reason) usage();
    const issue = loadIssue(number);
    const from = ownerLabel(args.from);
    const current = issue.labels.find(
      (label) =>
        label.name.startsWith('owner:') || label.name.startsWith('worker:'),
    )?.name;
    if (current !== from)
      throw new Error(
        `Fresh issue metadata assigns ${current ?? 'nobody'}, not ${from}.`,
      );
    const result = await transferClaim({
      repoRoot,
      issue,
      worker: args.from,
      toWorker: args.to,
      sessionId: args['session-id'],
      reason: args.reason,
      repository,
      updateIssue: async ({ issueNumber, fromLabel, toLabel }) => {
        const fresh = loadIssue(issueNumber);
        const labels = issueLabels(fresh);
        const statuses = labels.filter((label) => label.startsWith('status:'));
        if (
          !labels.includes(fromLabel) ||
          statuses.length !== 1 ||
          !['status:triage', 'status:ready', 'status:in-progress'].includes(
            statuses[0],
          )
        )
          throw new Error(
            'Fresh issue owner or status changed before handoff; preserved worktree needs inspection.',
          );
        const nextLabels = labels
          .filter(
            (label) => label !== fromLabel && !label.startsWith('status:'),
          )
          .concat(toLabel, 'status:ready');
        const candidate = { ...fresh, labels: nextLabels };
        const validation = validateIssue(candidate);
        if (!validation.valid || !validation.ready)
          throw new Error(
            `Fresh issue is not valid for handoff: ${validation.errors.join(' ')}`,
          );
        updateIssueLabels(issueNumber, nextLabels);
        const verified = loadIssue(issueNumber);
        const verifiedLabels = issueLabels(verified);
        if (
          !verifiedLabels.includes(toLabel) ||
          !verifiedLabels.includes('status:ready') ||
          verifiedLabels.some(
            (label) => label.startsWith('status:') && label !== 'status:ready',
          )
        )
          throw new Error(
            'Handoff labels did not reconcile; preserved worktree needs inspection.',
          );
      },
    });
    const refreshed = loadIssue(number);
    const refreshedLabels = refreshed.labels.map((label) => label.name);
    if (
      !refreshedLabels.includes(ownerLabel(args.to)) ||
      !refreshedLabels.includes('status:ready')
    )
      throw new Error(
        `Issue #${number} changed during handoff. The branch and handoff record were preserved; inspect current labels before reassignment.`,
      );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }
  usage();
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
