import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const repository = process.env.GITHUB_REPOSITORY ?? 'DanielssonThomas/Stellar';

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      (
        result.stderr ||
        result.error?.message ||
        result.stdout ||
        `${command} failed`
      ).trim(),
    );
  return result.stdout.trim();
}

function labels(issue) {
  return (issue.labels ?? []).map((item) =>
    typeof item === 'string' ? item : item.name,
  );
}

export function assessMergedIssue({ pr, issue, expectedHead }) {
  const reasons = [];
  const link = Number(issue?.number);
  const target = labels(issue)
    .find((item) => item.startsWith('target:'))
    ?.slice(7);
  const owner = labels(issue).find(
    (item) => item.startsWith('owner:') || item.startsWith('worker:'),
  );
  if (!Number.isSafeInteger(link) || link < 1 || !owner || !target)
    reasons.push('issue-metadata-missing');
  if (
    pr?.state !== 'MERGED' ||
    !pr.mergedAt ||
    pr.headRefOid !== expectedHead ||
    !/^[0-9a-f]{40}$/.test(expectedHead ?? '') ||
    pr.baseRefName !== target ||
    !new RegExp(
      `(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${link}\\b`,
      'i',
    ).test(pr.body ?? '')
  )
    reasons.push('exact-merge-not-verified');
  const section =
    issue?.body
      ?.split(/^#{1,6}\s+Acceptance criteria\s*$/im)[1]
      ?.split(/^#{1,6}\s+/m)[0] ?? '';
  const boxes = section.match(/^\s*-\s*\[[ xX]\]\s+\S.+$/gm) ?? [];
  if (!boxes.length || boxes.some((box) => !/^\s*-\s*\[[xX]\]/.test(box)))
    reasons.push('acceptance-not-complete');
  if (!['OPEN', 'CLOSED'].includes(issue?.state))
    reasons.push('issue-state-unknown');
  const statuses = labels(issue).filter((item) => item.startsWith('status:'));
  if (
    statuses.length !== 1 ||
    !['status:review', 'status:triage', 'status:done'].includes(statuses[0])
  )
    reasons.push('issue-status-not-completable');
  return {
    eligible: reasons.length === 0,
    reasons,
    owner,
    status: statuses[0],
  };
}

export function linkedIssueNumber(body) {
  const matches = [
    ...(body ?? '').matchAll(
      /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#([1-9]\d*)\b/gi,
    ),
  ];
  const numbers = [...new Set(matches.map((item) => Number(item[1])))];
  if (numbers.length !== 1)
    throw new Error(
      'Merged PR must link exactly one issue for automatic completion.',
    );
  return numbers[0];
}

export async function main(argv = process.argv.slice(2)) {
  const number = Number(argv[0]);
  const expectedHead = argv[1];
  if (
    !Number.isSafeInteger(number) ||
    number < 1 ||
    !/^[0-9a-f]{40}$/.test(expectedHead ?? '')
  )
    throw new Error(
      'Usage: post-merge-cleanup.mjs <PR-number> <event-head-SHA>',
    );
  const fetchPr = () =>
    JSON.parse(
      run('gh', [
        'pr',
        'view',
        String(number),
        '--repo',
        repository,
        '--json',
        'number,state,mergedAt,headRefOid,headRefName,baseRefName,body',
      ]),
    );
  const pr = fetchPr();
  const issueNumber = linkedIssueNumber(pr.body);
  const fetchIssue = () =>
    JSON.parse(
      run('gh', [
        'issue',
        'view',
        String(issueNumber),
        '--repo',
        repository,
        '--json',
        'number,state,body,labels',
      ]),
    );
  let issue = fetchIssue();
  let decision = assessMergedIssue({ pr, issue, expectedHead });
  if (!decision.eligible)
    throw new Error(
      `Merged issue cleanup preserved: ${decision.reasons.join(', ')}`,
    );
  if (decision.status === 'status:done') {
    if (issue.state !== 'CLOSED')
      throw new Error('Done issue was reopened; preserve for inspection.');
    return { issueNumber, alreadyComplete: true };
  }
  if (issue.state === 'OPEN') {
    if (fetchPr().headRefOid !== expectedHead)
      throw new Error('PR changed before issue close.');
    run('gh', [
      'issue',
      'close',
      String(issueNumber),
      '--repo',
      repository,
      '--reason',
      'completed',
    ]);
    issue = fetchIssue();
    decision = assessMergedIssue({ pr: fetchPr(), issue, expectedHead });
    if (!decision.eligible || issue.state !== 'CLOSED')
      throw new Error('Issue changed after close; preserve for inspection.');
  }
  run(process.execPath, [
    fileURLToPath(new URL('./update-issue.mjs', import.meta.url)),
    'status',
    String(issueNumber),
    '--worker',
    decision.owner,
    '--expected',
    decision.status,
    '--status',
    'done',
  ]);
  issue = fetchIssue();
  if (issue.state !== 'CLOSED' || !labels(issue).includes('status:done'))
    throw new Error('Governed issue completion did not reconcile.');
  process.stdout.write(
    `Completed issue #${issueNumber} for merged PR #${number}.\n`,
  );
  return { issueNumber, completed: true };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
