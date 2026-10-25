import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectClaim, releaseClaim } from './issue-worktree.mjs';

const repository = process.env.GITHUB_REPOSITORY ?? 'DanielssonThomas/Stellar';
const sha = /^[0-9a-f]{40,64}$/;

function command(executable, args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  if ((result.error || result.status !== 0) && !allowFailure)
    throw new Error(
      (result.stderr || result.error?.message || `${executable} failed`).trim(),
    );
  return result;
}

function git(root, ...args) {
  return command('git', ['-C', root, ...args], root).stdout.trim();
}

function github(args, root) {
  return JSON.parse(command('gh', args, root).stdout);
}

function registeredWorktrees(root) {
  return git(root, 'worktree', 'list', '--porcelain')
    .split(/\r?\n\r?\n/)
    .filter(Boolean)
    .map((entry) => ({
      path: resolve(entry.match(/^worktree (.+)$/m)?.[1] ?? ''),
      branch: entry.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? null,
    }));
}

function linked(issueNumber, body) {
  return new RegExp(
    `(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${issueNumber}\\b`,
    'i',
  ).test(body ?? '');
}

function protectedBranch(branch) {
  return /^(?:main|develop|release(?:\/|$))$/.test(branch ?? '');
}

export function assessCleanup({
  phase,
  claim,
  handoff,
  stopped,
  status,
  ignoredStatus,
  head,
  remoteHead,
  registration,
  worktreeAbsent = false,
  issue,
  pr,
  openPrs,
}) {
  const reasons = [];
  if (
    !claim ||
    !/^issue\/[1-9]\d*-[a-z0-9-]+$/.test(claim.branch ?? '') ||
    protectedBranch(claim.branch)
  )
    reasons.push('claim-or-branch-untrusted');
  if (
    (!registration && !worktreeAbsent) ||
    (registration &&
      (registration.branch !== claim?.branch ||
        resolve(registration.path) !== resolve(claim.worktreePath)))
  )
    reasons.push('registration-mismatch');
  if (claim?.state === 'active') reasons.push('active-claim');
  if (claim && !['released', 'transferred'].includes(claim.state))
    reasons.push('claim-not-released');
  if (
    stopped?.workerExited !== true ||
    stopped?.attemptContainersStopped !== true ||
    stopped?.verificationStopped !== true ||
    stopped?.issueNumber !== issue?.number ||
    stopped?.headSha !== head
  )
    reasons.push('process-or-container-unconfirmed');
  if (
    !handoff?.durable ||
    handoff.recoveryRequired ||
    handoff.task?.issueNumber !== issue?.number ||
    handoff.task?.branch !== claim?.branch ||
    resolve(handoff.task?.worktreePath ?? '') !==
      resolve(claim?.worktreePath ?? '') ||
    handoff.headSha !== head ||
    !['review-pending', 'integrated'].includes(handoff.status)
  )
    reasons.push('handoff-not-final');
  if (status !== '' || ignoredStatus !== '')
    reasons.push('worktree-has-content');
  if (
    !sha.test(head ?? '') ||
    (phase === 'post-job' && head !== remoteHead) ||
    (phase === 'merged' && remoteHead !== null && head !== remoteHead)
  )
    reasons.push('commit-not-preserved-on-remote');
  if (phase === 'merged') {
    const target = issue?.labels
      ?.map((item) => (typeof item === 'string' ? item : item.name))
      .find((item) => item.startsWith('target:'))
      ?.slice(7);
    if (
      issue?.state !== 'CLOSED' ||
      !issue.labels.some(
        (item) =>
          (typeof item === 'string' ? item : item.name) === 'status:done',
      )
    )
      reasons.push('issue-not-complete');
    if (
      pr?.state !== 'MERGED' ||
      pr.baseRefName !== target ||
      pr.headRefName !== claim?.branch ||
      pr.headRefOid !== head ||
      !linked(issue?.number, pr.body) ||
      !pr.mergedAt
    )
      reasons.push('merge-not-verified');
    if (
      !Array.isArray(openPrs) ||
      openPrs.some((item) => item.headRefName === claim?.branch)
    )
      reasons.push('open-pr-or-state-unknown');
  } else if (phase === 'post-job') {
    const target = issue?.labels
      ?.map((item) => (typeof item === 'string' ? item : item.name))
      .find((item) => item.startsWith('target:'))
      ?.slice(7);
    if (
      issue?.state !== 'OPEN' ||
      !issue.labels.some(
        (item) =>
          (typeof item === 'string' ? item : item.name) === 'status:review',
      ) ||
      handoff?.status !== 'review-pending' ||
      pr?.state !== 'OPEN' ||
      pr.baseRefName !== target ||
      pr.headRefName !== claim?.branch ||
      pr.headRefOid !== head ||
      !linked(issue?.number, pr.body)
    )
      reasons.push('post-job-review-not-ready');
  } else {
    reasons.push('unknown-phase');
  }
  return { eligible: reasons.length === 0, reasons };
}

async function appendAudit(auditPath, event) {
  if (!auditPath)
    throw new Error('An external durable audit path is required.');
  const file = await open(auditPath, 'a');
  try {
    await file.writeFile(
      `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`,
    );
    await file.sync();
  } finally {
    await file.close();
  }
}

export async function inspectLocalCleanup({
  root,
  issueNumber,
  phase,
  handoff,
  stopped,
}) {
  const claim = await inspectClaim(root, issueNumber);
  if (!claim) throw new Error('No governed issue claim exists.');
  const registration = registeredWorktrees(root).find(
    (item) => item.path === resolve(claim.worktreePath),
  );
  const worktreeAbsent = !registration && !existsSync(claim.worktreePath);
  if (!registration && !worktreeAbsent)
    throw new Error('Unregistered worktree path still exists; preserve it.');
  const status = registration
    ? git(
        claim.worktreePath,
        'status',
        '--porcelain=v1',
        '--untracked-files=all',
      )
    : '';
  const ignoredStatus = registration
    ? git(
        claim.worktreePath,
        'ls-files',
        '--others',
        '--ignored',
        '--exclude-standard',
      )
    : '';
  const localBranch =
    command(
      'git',
      [
        '-C',
        root,
        'show-ref',
        '--verify',
        '--quiet',
        `refs/heads/${claim.branch}`,
      ],
      root,
      { allowFailure: true },
    ).status === 0;
  const head = registration
    ? git(claim.worktreePath, 'rev-parse', 'HEAD')
    : localBranch
      ? git(root, 'rev-parse', `refs/heads/${claim.branch}`)
      : handoff.headSha;
  const remote = command(
    'git',
    ['ls-remote', '--heads', 'origin', claim.branch],
    root,
  ).stdout.trim();
  const remoteMatch = remote.match(/^([0-9a-f]{40,64})\s+refs\/heads\/(.+)$/);
  if (remote && remoteMatch?.[2] !== claim.branch)
    throw new Error('Remote branch lookup is ambiguous.');
  const remoteHead = remoteMatch?.[1] ?? null;
  const issue = github(
    [
      'issue',
      'view',
      String(issueNumber),
      '--repo',
      repository,
      '--json',
      'number,state,labels',
    ],
    root,
  );
  const prs = github(
    [
      'pr',
      'list',
      '--repo',
      repository,
      '--state',
      'all',
      '--limit',
      '1000',
      '--json',
      'number,body,state,baseRefName,headRefName,headRefOid,mergedAt',
    ],
    root,
  );
  if (prs.length === 1000)
    throw new Error('PR inventory may be truncated; preserve work.');
  const openPrs = prs.filter((pr) => pr.state === 'OPEN');
  const linkedPrs = prs.filter(
    (pr) => linked(issueNumber, pr.body) && pr.headRefName === claim.branch,
  );
  const pr =
    linkedPrs.length === 1
      ? github(
          [
            'pr',
            'view',
            String(linkedPrs[0].number),
            '--repo',
            repository,
            '--json',
            'number,body,state,baseRefName,headRefName,headRefOid,mergedAt',
          ],
          root,
        )
      : null;
  return {
    claim,
    registration,
    worktreeAbsent,
    localBranch,
    status,
    ignoredStatus,
    head,
    remoteHead,
    issue,
    pr,
    openPrs,
    handoff,
    stopped,
    phase,
  };
}

export async function cleanupIssue({
  root,
  issueNumber,
  phase,
  handoffPath,
  stopped,
  auditPath,
  releaseSessionId,
  remoteAuthorized = false,
}) {
  const handoff = JSON.parse(await readFile(handoffPath, 'utf8'));
  let state = await inspectLocalCleanup({
    root,
    issueNumber,
    phase,
    handoff,
    stopped,
  });
  if (
    state.claim.state === 'active' &&
    releaseSessionId &&
    state.claim.sessionId === releaseSessionId
  ) {
    const simulated = assessCleanup({
      ...state,
      claim: { ...state.claim, state: 'released' },
    });
    if (
      simulated.eligible ||
      (phase === 'merged' &&
        simulated.reasons.length === 1 &&
        simulated.reasons[0] === 'issue-not-complete')
    ) {
      await releaseClaim({
        repoRoot: root,
        issueNumber,
        worker: state.claim.worker,
        sessionId: releaseSessionId,
      });
      await appendAudit(auditPath, {
        issueNumber,
        releasedClaim: state.claim.sessionId,
      });
      state = await inspectLocalCleanup({
        root,
        issueNumber,
        phase,
        handoff,
        stopped,
      });
    }
  }
  if (
    phase === 'merged' &&
    state.claim.state === 'released' &&
    state.issue.state === 'CLOSED'
  ) {
    const labels = state.issue.labels.map((item) =>
      typeof item === 'string' ? item : item.name,
    );
    const expected = labels.find((item) => item.startsWith('status:'));
    if (expected && expected !== 'status:done') {
      const preliminary = assessCleanup({
        ...state,
        issue: {
          ...state.issue,
          labels: labels
            .filter((item) => !item.startsWith('status:'))
            .concat('status:done'),
        },
      });
      if (preliminary.eligible) {
        command(
          process.execPath,
          [
            fileURLToPath(new URL('./update-issue.mjs', import.meta.url)),
            'status',
            String(issueNumber),
            '--worker',
            state.claim.worker,
            '--expected',
            expected,
            '--status',
            'done',
          ],
          root,
        );
        await appendAudit(auditPath, {
          issueNumber,
          completedIssueStatus: true,
        });
        state = await inspectLocalCleanup({
          root,
          issueNumber,
          phase,
          handoff,
          stopped,
        });
      }
    }
  }
  const decision = assessCleanup(state);
  await appendAudit(auditPath, {
    issueNumber,
    phase,
    decision,
    branch: state.claim.branch,
    head: state.head,
  });
  if (!decision.eligible) return decision;
  // Reinspect immediately before changing Git's registered worktree. No force path exists.
  state = await inspectLocalCleanup({
    root,
    issueNumber,
    phase,
    handoff,
    stopped,
  });
  const fresh = assessCleanup(state);
  if (!fresh.eligible) {
    await appendAudit(auditPath, { issueNumber, phase, decision: fresh });
    return fresh;
  }
  if (state.registration) {
    command(
      'git',
      ['-C', root, 'worktree', 'remove', state.claim.worktreePath],
      root,
    );
    await appendAudit(auditPath, {
      issueNumber,
      removedWorktree: state.claim.worktreePath,
    });
  }
  if (phase === 'merged') {
    // A squash merge has no ancestor relationship; exact GitHub merge evidence
    // and the matching branch head authorize one explicitly named local ref.
    state = await inspectLocalCleanup({
      root,
      issueNumber,
      phase,
      handoff,
      stopped,
    });
    if (!assessCleanup(state).eligible)
      throw new Error(
        'Cleanup state changed after worktree removal; preserve branches.',
      );
    if (state.localBranch) {
      command('git', ['-C', root, 'branch', '-D', state.claim.branch], root);
      await appendAudit(auditPath, {
        issueNumber,
        deletedLocalBranch: state.claim.branch,
        head: state.head,
      });
    }
    state = await inspectLocalCleanup({
      root,
      issueNumber,
      phase,
      handoff,
      stopped,
    });
    if (!assessCleanup(state).eligible)
      throw new Error(
        'Cleanup state changed before remote deletion; preserve remote.',
      );
    const origin = git(root, 'remote', 'get-url', 'origin').toLowerCase();
    const ownHead = github(
      ['api', `repos/${repository}/pulls/${state.pr.number}`],
      root,
    ).head?.repo?.full_name;
    if (
      state.remoteHead &&
      remoteAuthorized === true &&
      ownHead?.toLowerCase() === repository.toLowerCase() &&
      origin.includes(repository.toLowerCase())
    ) {
      command(
        'git',
        [
          '-C',
          root,
          'push',
          `--force-with-lease=refs/heads/${state.claim.branch}:${state.remoteHead}`,
          'origin',
          `:refs/heads/${state.claim.branch}`,
        ],
        root,
      );
      await appendAudit(auditPath, {
        issueNumber,
        deletedRemoteBranch: state.claim.branch,
        head: state.remoteHead,
      });
    } else if (state.remoteHead) {
      await appendAudit(auditPath, {
        issueNumber,
        preservedRemoteBranch: state.claim.branch,
        reason: 'fork-or-origin-permission-unknown',
      });
    }
    command('git', ['-C', root, 'fetch', '--prune', 'origin'], root);
    await appendAudit(auditPath, { issueNumber, prunedTrackingRefs: true });
  }
  return { eligible: true, worktree: state.claim.worktreePath, phase };
}
