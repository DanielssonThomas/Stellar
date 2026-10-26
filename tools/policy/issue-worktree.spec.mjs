import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  claimWorktree,
  inspectClaim,
  issueBranch,
  releaseClaim,
  recoverExpiredReviewClaim,
  transferClaim,
  validateAssignment,
} from './issue-worktree.mjs';

const root = await mkdtemp(join(tmpdir(), 'stellar-worktree-policy-'));
after(async () => rm(root, { recursive: true, force: true }));

function fixtureIssue(overrides = {}) {
  return {
    number: 42,
    title: 'Repair a small widget',
    body: '## Objective\nRepair it.\n\n## Expected outcome\nIt works.\n\n## Acceptance criteria\n- [ ] The defect is fixed.\n\n## Constraints\nStay scoped.\n\n## Dependencies\nNone\n\n## Verification expectations\nRun the unit test.',
    state: 'OPEN',
    labels: [
      'priority:medium',
      'target:develop',
      'type:bug',
      'status:ready',
      'owner:codex',
    ],
    dependencies: [],
    ...overrides,
  };
}

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

function assignment(overrides = {}) {
  return validateAssignment({
    issue: fixtureIssue(),
    worker: 'codex',
    targetBranch: 'develop',
    dependencies: [],
    existingBranches: ['develop'],
    ...overrides,
  });
}

describe('issue worktree assignment', () => {
  it('accepts an owned issue with the exact existing target and resolved dependencies', () => {
    assert.deepEqual(assignment(), { valid: true, errors: [] });
  });

  it('rejects invalid metadata and a worker that does not own the issue', () => {
    const invalid = fixtureIssue({
      labels: [
        'priority:medium',
        'priority:high',
        'target:develop',
        'type:bug',
        'status:ready',
        'owner:codex',
      ],
    });
    assert.equal(assignment({ issue: invalid }).valid, false);
    assert.ok(
      assignment({ worker: 'local-4b' }).errors.some((error) =>
        error.includes('worker:local-4b'),
      ),
    );
  });

  it('rejects a substituted target and a missing target branch', () => {
    assert.ok(
      assignment({ targetBranch: 'main' }).errors.some((error) =>
        error.includes('does not match'),
      ),
    );
    assert.ok(
      assignment({ existingBranches: [] }).errors.some((error) =>
        error.includes('does not exist'),
      ),
    );
  });

  it('rejects unresolved or mismatched native dependencies', () => {
    const issue = fixtureIssue({
      body: fixtureIssue().body.replace(
        'Dependencies\nNone',
        'Dependencies\n#41',
      ),
    });
    assert.ok(
      assignment({
        issue,
        dependencies: [
          { number: 41, state: 'OPEN', status: 'status:in-progress' },
        ],
      }).errors.some((error) => error.includes('unresolved')),
    );
    assert.ok(
      assignment({ issue, dependencies: [] }).errors.some((error) =>
        error.includes('do not match'),
      ),
    );
  });

  it('permits triage only as recovery for the same active claim owner and session', () => {
    const triage = fixtureIssue({
      labels: fixtureIssue().labels.map((label) =>
        label === 'status:ready' ? 'status:triage' : label,
      ),
    });
    assert.equal(assignment({ issue: triage }).valid, false);
    assert.equal(
      assignment({ issue: triage, allowTriageRecovery: true }).valid,
      true,
    );
  });

  it('derives a stable issue branch name', () => {
    assert.equal(issueBranch(fixtureIssue()), 'issue/42-repair-a-small-widget');
  });

  it('admits review status only for the explicit resume path', () => {
    const review = fixtureIssue({
      labels: fixtureIssue().labels.map((label) =>
        label === 'status:ready' ? 'status:review' : label,
      ),
    });
    assert.equal(assignment({ issue: review }).valid, false);
    assert.equal(
      assignment({ issue: review, allowReviewResume: true }).valid,
      true,
    );
  });
});

describe('review-stage worktree resume', () => {
  it('reclaims only the existing linked PR head and preserves dirty work', async () => {
    const checkout = join(root, 'review-checkout');
    const remote = join(root, 'review-origin.git');
    await mkdir(checkout);
    git(root, 'init', '--bare', remote);
    git(checkout, 'init', '-b', 'develop');
    git(checkout, 'config', 'user.name', 'Stellar Test');
    git(checkout, 'config', 'user.email', 'stellar-test@example.invalid');
    await writeFile(join(checkout, 'README.md'), 'fixture\n');
    git(checkout, 'add', 'README.md');
    git(checkout, 'commit', '-m', 'fixture');
    git(checkout, 'remote', 'add', 'origin', remote);
    git(checkout, 'push', '-u', 'origin', 'develop');
    git(
      checkout,
      'fetch',
      'origin',
      'refs/heads/develop:refs/remotes/origin/develop',
    );
    const issue = fixtureIssue();
    const initial = await claimWorktree({
      repoRoot: checkout,
      issue,
      worker: 'codex',
      sessionId: 'first-session',
      targetBranch: 'develop',
    });
    const headRefOid = git(initial.worktreePath, 'rev-parse', 'HEAD');
    await releaseClaim({
      repoRoot: checkout,
      issueNumber: 42,
      worker: 'codex',
      sessionId: 'first-session',
    });
    await writeFile(join(initial.worktreePath, 'untracked.txt'), 'preserve me');
    const review = fixtureIssue({
      labels: issue.labels.map((label) =>
        label === 'status:ready' ? 'status:review' : label,
      ),
    });
    const reviewPr = {
      number: 80,
      state: 'OPEN',
      baseRefName: 'develop',
      headRefName: initial.branch,
      headRefOid,
      body: 'Fixes #42',
    };
    for (const changed of [
      { ...reviewPr, headRefOid: 'a'.repeat(40) },
      { ...reviewPr, baseRefName: 'main' },
      { ...reviewPr, body: 'No issue link' },
    ]) {
      await assert.rejects(
        claimWorktree({
          repoRoot: checkout,
          issue: review,
          worker: 'codex',
          sessionId: 'second-session',
          targetBranch: 'develop',
          reviewPr: changed,
        }),
        /Review resume/,
      );
    }
    const resumed = await claimWorktree({
      repoRoot: checkout,
      issue: review,
      worker: 'codex',
      sessionId: 'second-session',
      targetBranch: 'develop',
      reviewPr,
    });
    assert.equal(resumed.branch, initial.branch);
    assert.equal(
      await readFile(join(initial.worktreePath, 'untracked.txt'), 'utf8'),
      'preserve me',
    );
    await assert.rejects(
      claimWorktree({
        repoRoot: checkout,
        issue: review,
        worker: 'codex',
        sessionId: 'third-session',
        targetBranch: 'develop',
        reviewPr,
      }),
      /already active/,
    );
  });
});

describe('durable worktree claims', () => {
  it('recovers only an expired clean review claim for the exact PR and idle worktree', async () => {
    const checkout = join(root, 'expired-review-checkout');
    const remote = join(root, 'expired-review-origin.git');
    await mkdir(checkout);
    git(root, 'init', '--bare', remote);
    git(checkout, 'init', '-b', 'develop');
    git(checkout, 'config', 'user.name', 'Stellar Test');
    git(checkout, 'config', 'user.email', 'stellar-test@example.invalid');
    await writeFile(join(checkout, 'README.md'), 'fixture\n');
    git(checkout, 'add', 'README.md');
    git(checkout, 'commit', '-m', 'fixture');
    git(checkout, 'remote', 'add', 'origin', remote);
    git(checkout, 'push', '-u', 'origin', 'develop');
    git(checkout, 'fetch', 'origin');
    const claim = await claimWorktree({
      repoRoot: checkout,
      issue: fixtureIssue(),
      worker: 'codex',
      sessionId: 'expired-session',
      targetBranch: 'develop',
    });
    const review = fixtureIssue({
      labels: fixtureIssue().labels.map((label) =>
        label === 'status:ready' ? 'status:review' : label,
      ),
    });
    const pr = {
      number: 84,
      state: 'OPEN',
      baseRefName: 'develop',
      headRefName: claim.branch,
      headRefOid: git(claim.worktreePath, 'rev-parse', 'HEAD'),
      body: 'Fixes #42',
    };
    const claimFile = join(
      checkout,
      '.git',
      'stellar-agent',
      'claims',
      '42.json',
    );
    const base = {
      repoRoot: checkout,
      issueNumber: 42,
      worker: 'codex',
      fetchIssue: async () => review,
      fetchReviewPr: async () => pr,
      assertNoLiveWork: async () => true,
    };
    await assert.rejects(recoverExpiredReviewClaim(base), /expired active/);
    const expired = {
      ...JSON.parse(await readFile(claimFile, 'utf8')),
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    };
    await writeFile(claimFile, JSON.stringify(expired));
    await assert.rejects(
      recoverExpiredReviewClaim({ ...base, worker: 'maintainer' }),
      /owner/,
    );
    await assert.rejects(
      recoverExpiredReviewClaim({
        ...base,
        fetchReviewPr: async () => ({ ...pr, headRefOid: 'a'.repeat(40) }),
      }),
      /changed, or dirty/,
    );
    await assert.rejects(
      recoverExpiredReviewClaim({
        ...base,
        assertNoLiveWork: async () => {
          throw new Error('running worker');
        },
      }),
      /running worker/,
    );
    await assert.rejects(
      recoverExpiredReviewClaim({
        ...base,
        assertNoLiveWork: async () => {
          await writeFile(
            claimFile,
            JSON.stringify({ ...expired, branch: 'issue/42-other' }),
          );
        },
      }),
      /changed during recovery/,
    );
    await writeFile(claimFile, JSON.stringify(expired));
    await writeFile(join(claim.worktreePath, 'untracked.txt'), 'preserve');
    await assert.rejects(recoverExpiredReviewClaim(base), /changed, or dirty/);
    await rm(join(claim.worktreePath, 'untracked.txt'));
    const recovered = await recoverExpiredReviewClaim(base);
    assert.equal(recovered.state, 'released');
    assert.equal(recovered.reviewRecovery.prNumber, 84);
    assert.equal(
      (await recoverExpiredReviewClaim(base)).releasedAt,
      recovered.releasedAt,
    );
    assert.equal((await inspectClaim(checkout, 42)).state, 'released');
  });
  it('creates a dedicated worktree, resumes only the same session, and preserves changes', async () => {
    const checkout = join(root, 'checkout');
    const remote = join(root, 'origin.git');
    await mkdir(checkout);
    git(root, 'init', '--bare', remote);
    git(checkout, 'init', '-b', 'develop');
    git(checkout, 'config', 'user.name', 'Stellar Test');
    git(checkout, 'config', 'user.email', 'stellar-test@example.invalid');
    await writeFile(join(checkout, 'README.md'), 'fixture\n');
    git(checkout, 'add', 'README.md');
    git(checkout, 'commit', '-m', 'fixture');
    git(checkout, 'remote', 'add', 'origin', remote);
    git(checkout, 'push', '-u', 'origin', 'develop');
    git(
      checkout,
      'fetch',
      'origin',
      'refs/heads/develop:refs/remotes/origin/develop',
    );

    const issue = fixtureIssue();
    const first = await claimWorktree({
      repoRoot: checkout,
      issue,
      worker: 'codex',
      sessionId: 'session-a',
      targetBranch: 'develop',
    });
    assert.equal(first.state, 'active');
    assert.equal(first.branch, 'issue/42-repair-a-small-widget');
    assert.equal(dirname(first.worktreePath), dirname(checkout));
    assert.ok(first.worktreePath.endsWith(`${basename(checkout)}-issue-42`));
    await writeFile(join(first.worktreePath, 'uncommitted.txt'), 'preserve me');

    await assert.rejects(
      claimWorktree({
        repoRoot: checkout,
        issue,
        worker: 'codex',
        sessionId: 'session-b',
        targetBranch: 'develop',
      }),
      /already active in session session-a/,
    );
    const resumed = await claimWorktree({
      repoRoot: checkout,
      issue,
      worker: 'codex',
      sessionId: 'session-a',
      targetBranch: 'develop',
    });
    assert.equal(resumed.resumed, true);
    assert.equal(
      await readFile(join(resumed.worktreePath, 'uncommitted.txt'), 'utf8'),
      'preserve me',
    );

    const interrupted = {
      ...issue,
      labels: issue.labels.map((label) =>
        label === 'status:ready' ? 'status:triage' : label,
      ),
    };
    const recovered = await claimWorktree({
      repoRoot: checkout,
      issue: interrupted,
      worker: 'codex',
      sessionId: 'session-a',
      targetBranch: 'develop',
    });
    assert.equal(recovered.resumed, true);
    assert.equal(recovered.worktreePath, first.worktreePath);
    assert.equal(
      git(checkout, 'worktree', 'list', '--porcelain').includes(
        `branch refs/heads/${issueBranch(issue)}`,
      ),
      true,
    );

    const claimFile = join(
      checkout,
      '.git',
      'stellar-agent',
      'claims',
      '42.json',
    );
    const stale = JSON.parse(await readFile(claimFile, 'utf8'));
    stale.expiresAt = '2000-01-01T00:00:00.000Z';
    await writeFile(claimFile, `${JSON.stringify(stale, null, 2)}\n`);
    await assert.rejects(
      claimWorktree({
        repoRoot: checkout,
        issue,
        worker: 'codex',
        sessionId: 'session-b',
        targetBranch: 'develop',
      }),
      /stale claim/,
    );

    const inProgress = {
      ...issue,
      labels: issue.labels.map((label) =>
        label === 'status:ready' ? 'status:in-progress' : label,
      ),
    };
    const transferred = await transferClaim({
      repoRoot: checkout,
      issue: inProgress,
      worker: 'codex',
      toWorker: 'maintainer',
      reason: 'The owner is changing; preserve this investigation.',
      updateIssue: async () => true,
    });
    assert.equal(transferred.state, 'transferred');
    assert.equal(transferred.handoffs[0].to, 'owner:maintainer');
    const reassigned = {
      ...issue,
      labels: issue.labels.map((label) =>
        label === 'owner:codex' ? 'owner:maintainer' : label,
      ),
    };
    const next = await claimWorktree({
      repoRoot: checkout,
      issue: reassigned,
      worker: 'maintainer',
      sessionId: 'session-c',
      targetBranch: 'develop',
    });
    assert.equal(next.worktreePath, first.worktreePath);
    assert.equal(next.handoffs.length, 1);
    assert.equal(
      await readFile(join(next.worktreePath, 'uncommitted.txt'), 'utf8'),
      'preserve me',
    );
    assert.equal(
      (await inspectClaim(checkout, issue.number)).worker,
      'owner:maintainer',
    );
  });

  it('refuses an existing unregistered destination without removing it', async () => {
    const checkout = join(root, 'collision');
    const remote = join(root, 'collision-origin.git');
    await mkdir(checkout);
    git(root, 'init', '--bare', remote);
    git(checkout, 'init', '-b', 'develop');
    git(checkout, 'config', 'user.name', 'Stellar Test');
    git(checkout, 'config', 'user.email', 'stellar-test@example.invalid');
    await writeFile(join(checkout, 'README.md'), 'fixture\n');
    git(checkout, 'add', 'README.md');
    git(checkout, 'commit', '-m', 'fixture');
    git(checkout, 'remote', 'add', 'origin', remote);
    git(checkout, 'push', '-u', 'origin', 'develop');
    git(
      checkout,
      'fetch',
      'origin',
      'refs/heads/develop:refs/remotes/origin/develop',
    );
    const destination = join(root, `${basename(checkout)}-issue-42`);
    await mkdir(destination);
    await writeFile(join(destination, 'user-data.txt'), 'untouched');
    await assert.rejects(
      claimWorktree({
        repoRoot: checkout,
        issue: fixtureIssue(),
        worker: 'codex',
        sessionId: 'session-c',
        targetBranch: 'develop',
      }),
      /already exists and is not registered/,
    );
    assert.equal(
      await readFile(join(destination, 'user-data.txt'), 'utf8'),
      'untouched',
    );
  });
});
