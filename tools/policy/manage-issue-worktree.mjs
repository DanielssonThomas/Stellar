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

const repository = process.env.GITHUB_REPOSITORY ?? 'DanielssonThomas/Stellar';

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
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

function loadIssue(number) {
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

function usage() {
  throw new Error(
    [
      'Usage:',
      '  manage-issue-worktree.mjs claim <issue> --worker <codex|maintainer|profile-id> --session-id <stable-session-id>',
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
    const status = issue.labels.find((label) =>
      label.name.startsWith('status:'),
    )?.name;
    if (status === 'status:ready')
      run(
        'gh',
        [
          'issue',
          'edit',
          String(number),
          '--repo',
          repository,
          '--remove-label',
          'status:ready',
          '--add-label',
          'status:in-progress',
        ],
        repoRoot,
      );
    const refreshed = loadIssue(number);
    const refreshedLabels = refreshed.labels.map((label) => label.name);
    if (
      !refreshedLabels.includes(ownerLabel(args.worker)) ||
      !refreshedLabels.includes('status:in-progress')
    )
      throw new Error(
        `Issue #${number} changed during claim. The worktree was preserved; inspect its claim and current issue labels before continuing.`,
      );
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
