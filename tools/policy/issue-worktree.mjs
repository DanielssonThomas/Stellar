import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import {
  access,
  mkdir,
  open,
  readFile,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { validateIssue } from './validate-issue.mjs';
import { dependenciesFromBody } from './issue-dependency-identity.mjs';

export { dependenciesFromBody } from './issue-dependency-identity.mjs';

const leaseHours = 12;
const lockStaleMs = 60_000;

export function ownerLabel(worker) {
  if (worker.startsWith('owner:') || worker.startsWith('worker:'))
    return worker;
  return worker === 'codex' || worker === 'maintainer'
    ? `owner:${worker}`
    : `worker:${worker}`;
}

export function validateAssignment({
  issue,
  worker,
  targetBranch,
  dependencies,
  existingBranches,
  allowTriageRecovery = false,
  allowReviewResume = false,
}) {
  const errors = [];
  const labels = (issue.labels ?? []).map((label) =>
    typeof label === 'string' ? label : label.name,
  );
  const owner = ownerLabel(worker);
  const policyIssue =
    allowTriageRecovery && labels.includes('status:triage')
      ? {
          ...issue,
          labels: labels.map((label) =>
            label === 'status:triage' ? 'status:ready' : label,
          ),
        }
      : issue;
  const policy = validateIssue(policyIssue);
  if (issue.state && issue.state !== 'OPEN') errors.push('Issue is not open.');
  if (!policy.valid) errors.push(...policy.errors);
  if (
    ![
      'status:ready',
      'status:in-progress',
      ...(allowReviewResume ? ['status:review'] : []),
      ...(allowTriageRecovery ? ['status:triage'] : []),
    ].some((label) => labels.includes(label))
  )
    errors.push('Issue must be ready or already in progress.');
  if (!labels.includes(owner)) errors.push(`Issue owner must be ${owner}.`);
  const target = labels.find((label) => label.startsWith('target:'));
  if (!target) errors.push('Issue target is missing.');
  else if (target.slice('target:'.length) !== targetBranch)
    errors.push(
      `Issue target ${target.slice('target:'.length)} does not match ${targetBranch}.`,
    );
  if (!existingBranches.includes(targetBranch))
    errors.push(
      `Authorized target branch ${targetBranch} does not exist locally as a remote-tracking branch.`,
    );

  const expected = dependenciesFromBody(issue.body);
  if (expected === null) errors.push('Issue Dependencies section is missing.');
  else {
    const native = (dependencies ?? []).map((dependency) =>
      Number(dependency.number ?? dependency),
    );
    if (new Set(expected).size !== expected.length)
      errors.push('Issue lists duplicate dependencies.');
    if (new Set(native).size !== native.length)
      errors.push('Native dependencies contain duplicates.');
    if (
      expected.some((number) => !native.includes(number)) ||
      native.some((number) => !expected.includes(number))
    )
      errors.push(
        'Issue body and native blocked-by dependencies do not match.',
      );
    for (const dependency of dependencies ?? []) {
      const number = Number(dependency.number ?? dependency);
      if (dependency.state && dependency.state !== 'CLOSED')
        errors.push(`Dependency #${number} is unresolved.`);
      if (dependency.status && dependency.status !== 'status:done')
        errors.push(`Dependency #${number} is unresolved.`);
    }
  }
  return { valid: errors.length === 0, errors };
}

export function issueBranch(issue) {
  const slug = issue.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48)
    .replace(/-$/g, '');
  return `issue/${issue.number}-${slug}`;
}

function validIssueBranch(issueNumber, branch) {
  return (
    typeof branch === 'string' &&
    new RegExp(`^issue/${issueNumber}-[a-z0-9-]+$`).test(branch)
  );
}

function git(args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0 && !allowFailure)
    throw new Error(
      (result.stderr || result.stdout || `git ${args.join(' ')} failed`).trim(),
    );
  return result;
}

function worktrees(repoRoot) {
  const output = git(['worktree', 'list', '--porcelain'], repoRoot).stdout;
  return output
    .split(/\r?\n\r?\n/)
    .filter(Boolean)
    .map((entry) => {
      const path = entry.match(/^worktree (.+)$/m)?.[1];
      const branch = entry.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? null;
      const detached = /^detached$/m.test(entry);
      return { path: path ? resolve(path) : null, branch, detached };
    });
}

async function acquireLock(lockPath) {
  const token = randomUUID();
  try {
    const handle = await open(lockPath, 'wx');
    await handle.writeFile(
      JSON.stringify({
        token,
        pid: process.pid,
        createdAt: new Date().toISOString(),
      }),
    );
    await handle.close();
    return async () => {
      try {
        const current = JSON.parse(await readFile(lockPath, 'utf8'));
        if (current.token === token) await unlink(lockPath);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const details = await readFile(lockPath, 'utf8')
      .then(JSON.parse)
      .catch(() => null);
    const age = await stat(lockPath)
      .then((value) => Date.now() - value.mtimeMs)
      .catch(() => 0);
    if (details && age > lockStaleMs && !processIsRunning(details.pid)) {
      await unlink(lockPath);
      return acquireLock(lockPath);
    }
    throw new Error(
      'Another issue-worktree operation holds the claim lock. Retry after it finishes; do not remove the lock while its process is active.',
    );
  }
}

function processIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function writeRecord(file, record) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, {
    flag: 'wx',
  });
  const { rename } = await import('node:fs/promises');
  await rename(temporary, file);
}

export async function claimWorktree({
  repoRoot,
  issue,
  worker,
  sessionId,
  targetBranch,
  reviewPr = null,
  ttlHours: ttl = leaseHours,
}) {
  if (!sessionId || !/^[a-zA-Z0-9._:-]{1,128}$/.test(sessionId))
    throw new Error('Provide a stable, unique session ID from the supervisor.');
  const root = resolve(repoRoot);
  const commonDirRaw = git(
    ['rev-parse', '--git-common-dir'],
    root,
  ).stdout.trim();
  const commonDir = resolve(root, commonDirRaw);
  const registry = join(commonDir, 'stellar-agent', 'claims');
  await mkdir(registry, { recursive: true });
  const claimFile = join(registry, `${issue.number}.json`);
  const releaseLock = await acquireLock(`${claimFile}.lock`);
  try {
    const existingBranches = git(
      ['for-each-ref', '--format=%(refname:strip=3)', 'refs/remotes/origin'],
      root,
    )
      .stdout.split(/\r?\n/)
      .filter(Boolean);
    let record = await readFile(claimFile, 'utf8')
      .then(JSON.parse)
      .catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
    const recoverTriage =
      (issue.labels ?? []).some(
        (label) =>
          (typeof label === 'string' ? label : label.name) === 'status:triage',
      ) &&
      record?.state === 'active' &&
      record.worker === ownerLabel(worker) &&
      record.sessionId === sessionId;
    const nativeDependencies = issue.dependencies ?? [];
    const validation = validateAssignment({
      issue,
      worker,
      targetBranch,
      dependencies: nativeDependencies,
      existingBranches,
      allowTriageRecovery: recoverTriage,
      allowReviewResume: Boolean(reviewPr),
    });
    if (!validation.valid)
      throw new Error(
        `Issue #${issue.number} is not claimable: ${validation.errors.join(' ')}`,
      );

    let branch = issueBranch(issue);
    if (!validIssueBranch(issue.number, branch))
      throw new Error('Could not create a safe issue branch name.');
    const repositoryRoot = dirname(commonDir);
    let worktreePath = resolve(
      dirname(repositoryRoot),
      `${basename(repositoryRoot)}-issue-${issue.number}`,
    );
    if (!isAbsolute(worktreePath))
      throw new Error('Worktree path must be absolute.');
    const now = Date.now();
    if (record?.state === 'active' && Date.parse(record.expiresAt) > now) {
      if (record.worker !== ownerLabel(worker))
        throw new Error(
          `Issue #${issue.number} is claimed by ${record.worker} until ${record.expiresAt}.`,
        );
      if (record.sessionId !== sessionId)
        throw new Error(
          `Issue #${issue.number} is already active in session ${record.sessionId}; use explicit transfer or recovery.`,
        );
      if (
        !validIssueBranch(issue.number, record.branch) ||
        record.target !== targetBranch
      )
        throw new Error(
          'Current issue branch or target differs from the recorded claim; preserve it and use explicit recovery.',
        );
      const registered = worktrees(root).find(
        (entry) => entry.path === resolve(record.worktreePath),
      );
      if (!registered || registered.branch !== record.branch)
        throw new Error(
          'The active claim does not match a registered worktree; preserve it and use explicit recovery.',
        );
      if (
        reviewPr &&
        (reviewPr.state !== 'OPEN' ||
          reviewPr.baseRefName !== targetBranch ||
          reviewPr.headRefName !== record.branch ||
          git(['rev-parse', 'HEAD'], registered.path).stdout.trim() !==
            reviewPr.headRefOid)
      )
        throw new Error('Review PR changed during claim recovery.');
      record.expiresAt = new Date(now + ttl * 3_600_000).toISOString();
      record.lastResumedAt = new Date(now).toISOString();
      await writeRecord(claimFile, record);
      return { ...record, resumed: true };
    }
    if (record?.state === 'active')
      throw new Error(
        `Issue #${issue.number} has a stale claim. Inspect and explicitly transfer it before resuming.`,
      );

    const entries = worktrees(root);
    let pathEntry = entries.find((entry) => entry.path === worktreePath);
    const issueEntries = entries.filter((entry) =>
      validIssueBranch(issue.number, entry.branch),
    );
    if (!pathEntry && issueEntries.length > 1)
      throw new Error(
        `Multiple worktrees already use issue #${issue.number} branches; inspect them before choosing one.`,
      );
    if (!pathEntry && issueEntries.length === 1) {
      pathEntry = issueEntries[0];
      branch = pathEntry.branch;
      worktreePath = pathEntry.path;
    } else if (pathEntry && !validIssueBranch(issue.number, pathEntry.branch)) {
      throw new Error(
        `Worktree path already belongs to ${pathEntry.branch ?? 'a detached HEAD'}; it was left untouched.`,
      );
    } else if (pathEntry) {
      branch = pathEntry.branch;
    }
    if (!validIssueBranch(issue.number, branch))
      throw new Error('Could not create a safe issue branch name.');
    const branchEntry = entries.find((entry) => entry.branch === branch);
    if (branchEntry && branchEntry.path !== worktreePath)
      throw new Error(
        `Issue branch is already checked out at ${branchEntry.path}; it was left untouched.`,
      );
    const pathExists = await access(worktreePath, constants.F_OK)
      .then(() => true)
      .catch(() => false);
    if (pathExists && !pathEntry)
      throw new Error(
        `Worktree destination already exists and is not registered to this issue: ${worktreePath}`,
      );

    const targetRef = `origin/${targetBranch}`;
    const branchExists =
      git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], root, {
        allowFailure: true,
      }).status === 0;
    if (reviewPr) {
      const link = new RegExp(
        `(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${issue.number}\\b`,
        'i',
      );
      if (
        reviewPr.state !== 'OPEN' ||
        reviewPr.baseRefName !== targetBranch ||
        reviewPr.headRefName !== branch ||
        !link.test(reviewPr.body ?? '') ||
        !/^[0-9a-f]{40}$/.test(reviewPr.headRefOid ?? '') ||
        !pathEntry ||
        !branchExists ||
        !record ||
        record.state !== 'released' ||
        record.worker !== ownerLabel(worker) ||
        record.target !== targetBranch ||
        record.branch !== branch ||
        resolve(record.worktreePath) !== worktreePath ||
        git(['rev-parse', 'HEAD'], worktreePath).stdout.trim() !==
          reviewPr.headRefOid
      )
        throw new Error(
          'Review resume requires the same open issue-linked PR, released claim, branch, and registered worktree at its current head.',
        );
    }
    record = {
      issue: issue.number,
      worker: ownerLabel(worker),
      sessionId,
      branch,
      target: targetBranch,
      worktreePath,
      state: 'active',
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttl * 3_600_000).toISOString(),
      handoffs: record?.handoffs ?? [],
    };
    if (
      await access(claimFile, constants.F_OK)
        .then(() => true)
        .catch(() => false)
    ) {
      if (
        !['released', 'transferred'].includes(
          (await readFile(claimFile, 'utf8').then(JSON.parse)).state,
        )
      )
        throw new Error(
          'Existing claim must be explicitly recovered or transferred before it can be replaced.',
        );
      await writeRecord(claimFile, record);
    } else {
      const handle = await open(claimFile, 'wx');
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`);
      await handle.close();
    }
    try {
      if (!pathEntry) {
        const args = branchExists
          ? ['worktree', 'add', worktreePath, branch]
          : ['worktree', 'add', '-b', branch, worktreePath, targetRef];
        git(args, root);
      }
      const registered = worktrees(root).find(
        (entry) => entry.path === worktreePath,
      );
      if (!registered || registered.branch !== branch)
        throw new Error('Git did not register the expected issue worktree.');
      return record;
    } catch (error) {
      record.state = 'recovery-required';
      record.lastError = error.message;
      await writeRecord(claimFile, record);
      throw error;
    }
  } finally {
    await releaseLock();
  }
}

export async function inspectClaim(repoRoot, issueNumber) {
  const root = resolve(repoRoot);
  const commonDir = resolve(
    root,
    git(['rev-parse', '--git-common-dir'], root).stdout.trim(),
  );
  const file = join(
    commonDir,
    'stellar-agent',
    'claims',
    `${issueNumber}.json`,
  );
  return readFile(file, 'utf8')
    .then(JSON.parse)
    .catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
}

export async function releaseClaim({
  repoRoot,
  issueNumber,
  worker,
  sessionId,
}) {
  const root = resolve(repoRoot);
  const commonDir = resolve(
    root,
    git(['rev-parse', '--git-common-dir'], root).stdout.trim(),
  );
  const file = join(
    commonDir,
    'stellar-agent',
    'claims',
    `${issueNumber}.json`,
  );
  const releaseLock = await acquireLock(`${file}.lock`);
  try {
    const current = await inspectClaim(root, issueNumber);
    if (!current)
      throw new Error(`No local claim exists for issue #${issueNumber}.`);
    if (current.worker !== ownerLabel(worker))
      throw new Error(
        `Claim belongs to ${current.worker}; ${ownerLabel(worker)} cannot release it.`,
      );
    if (current.sessionId !== sessionId)
      throw new Error(
        `Claim belongs to session ${current.sessionId}; another session cannot release it.`,
      );
    if (current.state !== 'active')
      throw new Error(`Claim is ${current.state}; inspect it before release.`);
    const record = {
      ...current,
      state: 'released',
      releasedAt: new Date().toISOString(),
    };
    await writeRecord(file, record);
    return record;
  } finally {
    await releaseLock();
  }
}

/** Release an expired review claim after rechecking the same PR and clean worktree. */
export async function recoverExpiredReviewClaim({
  repoRoot,
  issueNumber,
  worker,
  fetchIssue,
  fetchReviewPr,
  assertNoLiveWork,
}) {
  const root = resolve(repoRoot);
  const commonDir = resolve(
    root,
    git(['rev-parse', '--git-common-dir'], root).stdout.trim(),
  );
  const file = join(
    commonDir,
    'stellar-agent',
    'claims',
    `${issueNumber}.json`,
  );
  const releaseLock = await acquireLock(`${file}.lock`);
  try {
    const record = await readFile(file, 'utf8').then(JSON.parse);
    if (
      record.state === 'released' &&
      record.reviewRecovery?.reason === 'expired-review-claim'
    )
      return record;
    if (
      record.state !== 'active' ||
      record.worker !== ownerLabel(worker) ||
      !Number.isFinite(Date.parse(record.expiresAt)) ||
      Date.parse(record.expiresAt) >= Date.now()
    )
      throw new Error(
        'Only the owner of an expired active claim may recover review work.',
      );
    if (
      !validIssueBranch(issueNumber, record.branch) ||
      !isAbsolute(record.worktreePath)
    )
      throw new Error(
        'Expired review claim has invalid branch or worktree identity.',
      );
    const issue = await fetchIssue(issueNumber);
    const labels = (issue.labels ?? []).map((entry) =>
      typeof entry === 'string' ? entry : entry.name,
    );
    if (
      issue.number !== issueNumber ||
      issue.state !== 'OPEN' ||
      labels.filter((entry) => entry.startsWith('status:')).join(',') !==
        'status:review' ||
      !labels.includes(ownerLabel(worker)) ||
      !labels.includes(`target:${record.target}`)
    )
      throw new Error(
        'Fresh review issue no longer matches the expired claim.',
      );
    const validation = validateAssignment({
      issue,
      worker,
      targetBranch: record.target,
      dependencies: issue.dependencies,
      existingBranches: [record.target],
      allowReviewResume: true,
    });
    if (!validation.valid)
      throw new Error('Fresh review issue failed assignment validation.');
    const reviewPr = await fetchReviewPr(issueNumber, record.target);
    const link = new RegExp(
      `(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${issueNumber}\\b`,
      'i',
    );
    if (
      reviewPr?.state !== 'OPEN' ||
      reviewPr.baseRefName !== record.target ||
      reviewPr.headRefName !== record.branch ||
      !/^[a-f0-9]{40}$/.test(reviewPr.headRefOid ?? '') ||
      !link.test(reviewPr.body ?? '')
    )
      throw new Error('Fresh review PR does not match the expired claim.');
    const registered = worktrees(root).find(
      (entry) => entry.path === resolve(record.worktreePath),
    );
    if (
      !registered ||
      registered.branch !== record.branch ||
      git(['rev-parse', 'HEAD'], registered.path).stdout.trim() !==
        reviewPr.headRefOid ||
      git(
        ['status', '--porcelain=v1', '--untracked-files=all'],
        registered.path,
      ).stdout.trim()
    )
      throw new Error('Review worktree is unregistered, changed, or dirty.');
    await assertNoLiveWork({ issueNumber, worktreePath: registered.path });
    if (
      JSON.stringify(JSON.parse(await readFile(file, 'utf8'))) !==
      JSON.stringify(record)
    )
      throw new Error('Review claim changed during recovery.');
    const recovered = {
      ...record,
      state: 'released',
      releasedAt: new Date().toISOString(),
      reviewRecovery: {
        reason: 'expired-review-claim',
        at: new Date().toISOString(),
        prNumber: reviewPr.number,
        head: reviewPr.headRefOid,
      },
    };
    await writeRecord(file, recovered);
    return recovered;
  } finally {
    await releaseLock();
  }
}

export async function transferClaim({
  repoRoot,
  issue,
  worker,
  toWorker,
  sessionId,
  reason,
  repository = 'DanielssonThomas/Stellar',
  updateIssue,
}) {
  if (!reason?.trim()) throw new Error('A handoff reason is required.');
  const root = resolve(repoRoot);
  const commonDir = resolve(
    root,
    git(['rev-parse', '--git-common-dir'], root).stdout.trim(),
  );
  const registry = join(commonDir, 'stellar-agent', 'claims');
  const file = join(registry, `${issue.number}.json`);
  const releaseLock = await acquireLock(`${file}.lock`);
  try {
    const record = await readFile(file, 'utf8')
      .then(JSON.parse)
      .catch((error) => {
        if (error.code === 'ENOENT')
          throw new Error(`No local claim exists for issue #${issue.number}.`);
        throw error;
      });
    if (record.state !== 'active')
      throw new Error(`Claim is ${record.state}; inspect it before transfer.`);
    if (record.worker !== ownerLabel(worker))
      throw new Error(
        `Claim belongs to ${record.worker}; ${ownerLabel(worker)} cannot transfer it.`,
      );
    if (
      Date.parse(record.expiresAt) > Date.now() &&
      record.sessionId !== sessionId
    )
      throw new Error(
        `Claim is active in session ${record.sessionId}; only that session can hand it off before lease expiry.`,
      );
    const registered = worktrees(root).find(
      (entry) => entry.path === resolve(record.worktreePath),
    );
    if (!registered || registered.branch !== record.branch)
      throw new Error(
        'Claim worktree is not registered as expected; preserve it and inspect before transfer.',
      );

    const labels = (issue.labels ?? []).map((label) =>
      typeof label === 'string' ? label : label.name,
    );
    const fromLabel = ownerLabel(worker);
    const toLabel = ownerLabel(toWorker);
    if (fromLabel === toLabel)
      throw new Error('A claim handoff must change the assigned owner.');
    if (!labels.includes(fromLabel))
      throw new Error(`Fresh issue metadata no longer assigns ${fromLabel}.`);
    const statuses = labels.filter((label) => label.startsWith('status:'));
    if (
      statuses.length !== 1 ||
      !['status:triage', 'status:ready', 'status:in-progress'].includes(
        statuses[0],
      )
    )
      throw new Error(
        'Issue status changed or is not recoverable; the worktree was preserved.',
      );
    const reassigned = {
      ...issue,
      labels: labels
        .filter((label) => ![fromLabel, ...statuses].includes(label))
        .concat([toLabel, 'status:ready']),
    };
    const check = validateIssue(reassigned);
    if (!check.valid || !check.ready)
      throw new Error(
        `Transfer target is not authorized or issue is invalid: ${check.errors.join(' ')}`,
      );
    const next = {
      ...record,
      state: 'transferred',
      expiresAt: new Date().toISOString(),
      handoffs: [
        ...(record.handoffs ?? []),
        {
          from: record.worker,
          to: toLabel,
          at: new Date().toISOString(),
          reason: reason.trim(),
          worktreePath: record.worktreePath,
          branch: record.branch,
        },
      ],
    };
    await writeRecord(file, next);
    try {
      if (updateIssue) {
        await updateIssue({
          issueNumber: issue.number,
          fromLabel,
          toLabel,
          issue,
          labels: reassigned.labels,
        });
      } else {
        const result = spawnSync(
          'gh',
          [
            'api',
            '--repo',
            repository,
            '--method',
            'PATCH',
            `repos/${repository}/issues/${issue.number}`,
            '--input',
            '-',
          ],
          {
            input: JSON.stringify({ labels: reassigned.labels }),
            encoding: 'utf8',
            windowsHide: true,
          },
        );
        if (result.status !== 0)
          throw new Error(
            (
              result.stderr ||
              result.stdout ||
              'GitHub issue transfer failed'
            ).trim(),
          );
      }
    } catch (error) {
      next.state = 'recovery-required';
      next.lastError = `Transfer metadata update failed after preserving the worktree: ${error.message}`;
      await writeRecord(file, next);
      throw error;
    }
    return next;
  } finally {
    await releaseLock();
  }
}
