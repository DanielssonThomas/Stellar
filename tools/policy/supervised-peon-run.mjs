import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { inspectClaim } from './issue-worktree.mjs';
import { loadIssue } from './manage-issue-worktree.mjs';
import {
  cancelRestrictedVerification,
  createPeonWorkerAdapter,
  getTrustedProtectedPathsForContext,
  inspectRestrictedWorkspace,
  readRestrictedWorkspaceFile,
  runRestrictedVerification,
  verifyPinnedWorkerImageCompatibility,
} from './run-restricted-worker.mjs';
import { validateFreshIssue } from './update-issue.mjs';
import { defaultLimits, superviseWorker } from './supervise-worker.mjs';
import {
  resolvePeonHermesProfile,
  resolvePeonHermesWorkflow,
  maxForwardedRequestsForWorkflow,
} from './peon-hermes-profiles.mjs';
import { buildPeonTaskContextManifest } from './peon-task-context.mjs';
import { reserveBoundedCodingAttempt } from './bounded-attempt-lease.mjs';

const imagePattern =
  /^ghcr\.io\/stellar-ai-corp\/hermes-worker@sha256:[a-f0-9]{64}$/;
export const trustedPeonWorkerImage =
  'ghcr.io/stellar-ai-corp/hermes-worker@sha256:e847e440fb57416aba8336781114a4f9b29d8c9275131cf5a84e019ee870ef31';

export function resolveCurrentDevelopHead(repositoryRoot) {
  const result = spawnSync(
    'git',
    [
      'ls-remote',
      'https://github.com/DanielssonThomas/Stellar.git',
      'refs/heads/develop',
    ],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
    },
  );
  const match = /^([a-f0-9]{40,64})\s+refs\/heads\/develop\s*$/m.exec(
    result.stdout ?? '',
  );
  if (result.error || result.status !== 0 || !match)
    throw new Error('Could not fetch the current public develop revision.');
  return match[1];
}

function inspectClaimedWorktree(repositoryRoot, claim) {
  const listed = spawnSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (listed.error || listed.status !== 0)
    throw new Error('Could not inspect registered issue worktrees.');
  const registered = (listed.stdout ?? '').split(/\r?\n\r?\n/).some((entry) => {
    const registeredPath = entry.match(/^worktree (.+)$/m)?.[1];
    const branch = entry.match(/^branch refs\/heads\/(.+)$/m)?.[1];
    return (
      registeredPath &&
      path.resolve(registeredPath).toLowerCase() ===
        path.resolve(claim.worktreePath).toLowerCase() &&
      branch === claim.branch
    );
  });
  if (!registered)
    throw new Error('Issue claim does not identify its registered worktree.');
  const read = (args) => {
    const result = spawnSync('git', ['-C', claim.worktreePath, ...args], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.error || result.status !== 0)
      throw new Error('Could not inspect the claimed issue worktree.');
    return (result.stdout ?? '').trim();
  };
  const root = read(['rev-parse', '--show-toplevel']);
  const branch = read(['branch', '--show-current']);
  const headRevision = read(['rev-parse', 'HEAD']);
  const status = read(['status', '--porcelain=v1', '--untracked-files=all']);
  if (
    path.resolve(root).toLowerCase() !==
      path.resolve(claim.worktreePath).toLowerCase() ||
    branch !== claim.branch ||
    !/^[a-f0-9]{40,64}$/.test(headRevision)
  )
    throw new Error('Claimed issue worktree identity is inconsistent.');
  return { headRevision, clean: status.length === 0 };
}

function label(issue, prefix) {
  return issue.labels
    .map((item) => (typeof item === 'string' ? item : item.name))
    .find((item) => item.startsWith(prefix));
}

function issueOwner(issue) {
  return issue.labels
    .map((item) => (typeof item === 'string' ? item : item.name))
    .find((item) => item.startsWith('owner:') || item.startsWith('worker:'));
}

function freshIssueFingerprint(issue) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        number: issue.number,
        state: issue.state,
        title: issue.title,
        body: issue.body,
        labels: issue.labels,
        dependencies: issue.dependencies,
      }),
    )
    .digest('hex');
}

export function validateLivePeonAssignment({
  issue,
  claim,
  sessionId,
  image = trustedPeonWorkerImage,
  now = Date.now(),
}) {
  if (!Number.isSafeInteger(issue?.number) || issue.number < 1)
    throw new Error('A validated Stellar issue is required.');
  if (issue.state !== 'OPEN')
    throw new Error('The assigned issue must be open.');
  if (issueOwner(issue) !== 'worker:peon')
    throw new Error('The assigned issue must be owned by worker:peon.');
  const hermesProfile = resolvePeonHermesProfile(issue);
  const hermesWorkflow = resolvePeonHermesWorkflow(issue);
  const maxForwardedRequests =
    maxForwardedRequestsForWorkflow(hermesWorkflow) ?? null;
  if (label(issue, 'status:') !== 'status:in-progress')
    throw new Error('The assigned issue must be in progress.');
  if (label(issue, 'target:') !== 'target:develop')
    throw new Error('Peon may only target develop.');
  const metadata = validateFreshIssue(issue, 'peon');
  if (!metadata.valid)
    throw new Error(
      `Assigned issue metadata is invalid: ${metadata.errors.join(' ')}`,
    );
  if (
    !Array.isArray(issue.dependencies) ||
    issue.dependencies.some(
      (dependency) =>
        dependency.state !== 'CLOSED' || dependency.status !== 'status:done',
    )
  )
    throw new Error('All issue dependencies must be closed with status:done.');
  if (!imagePattern.test(image ?? ''))
    throw new Error('Peon requires a pinned worker image digest.');
  if (image !== trustedPeonWorkerImage)
    throw new Error('Peon requires the trusted worker image digest.');
  if (!sessionId || typeof sessionId !== 'string')
    throw new Error('The active supervisor session ID is required.');
  if (
    claim?.state !== 'active' ||
    claim.worker !== 'worker:peon' ||
    claim.sessionId !== sessionId ||
    claim.target !== 'develop' ||
    !new RegExp(`^issue/${issue.number}-[a-z0-9-]+$`).test(
      claim.branch ?? '',
    ) ||
    !path.isAbsolute(claim.worktreePath ?? '') ||
    !Number.isFinite(Date.parse(claim.expiresAt)) ||
    Date.parse(claim.expiresAt) <= now
  )
    throw new Error(
      'The active issue claim does not match this Peon assignment.',
    );
  return {
    issueNumber: issue.number,
    owner: 'worker:peon',
    targetBranch: 'develop',
    branch: claim.branch,
    worktreePath: claim.worktreePath,
    hermesProfile,
    hermesWorkflow,
    maxForwardedRequests,
    sessionId,
  };
}

function validateVerificationCommands(commands) {
  if (
    !Array.isArray(commands) ||
    commands.length === 0 ||
    commands.some(
      (entry) =>
        !/^[a-z][a-z0-9-]{1,40}$/.test(entry?.name ?? '') ||
        !Array.isArray(entry.command) ||
        entry.command.length === 0 ||
        entry.command.some(
          (argument) =>
            typeof argument !== 'string' ||
            !argument.trim() ||
            argument.includes('\0'),
        ),
    )
  )
    throw new Error(
      'Trusted verification commands must be named argument lists.',
    );
}

export async function runSupervisedPeonIssue({
  issueNumber,
  sessionId,
  image = trustedPeonWorkerImage,
  repositoryRoot,
  handoffPath,
  verificationCommands,
  contextPlan,
  signal,
  loadAssignment = loadIssue,
  readClaim = inspectClaim,
  inspectWorktree = inspectRestrictedWorkspace,
  inspectRegisteredWorktree = inspectClaimedWorktree,
  readWorkspaceFile = readRestrictedWorkspaceFile,
  getProtectedPaths = getTrustedProtectedPathsForContext,
  resolveDevelopHead = resolveCurrentDevelopHead,
  reserveAttempt = reserveBoundedCodingAttempt,
  verifyImageCompatibility = verifyPinnedWorkerImageCompatibility,
  createWorkerAdapter = createPeonWorkerAdapter,
  runVerification = runRestrictedVerification,
  cancelVerification = cancelRestrictedVerification,
  runSupervisor = superviseWorker,
}) {
  const number = Number(issueNumber);
  if (!Number.isSafeInteger(number) || number < 1)
    throw new Error('issueNumber must be a positive integer.');
  if (!path.isAbsolute(repositoryRoot ?? ''))
    throw new Error('A trusted absolute repository root is required.');
  if (!path.isAbsolute(handoffPath ?? ''))
    throw new Error('A trusted absolute handoff path is required.');
  validateVerificationCommands(verificationCommands);

  const [issue, claim] = await Promise.all([
    loadAssignment(number),
    readClaim(repositoryRoot, number),
  ]);
  if (issue?.number !== number)
    throw new Error(
      'The fetched issue number differs from the requested assignment.',
    );
  const task = validateLivePeonAssignment({
    issue,
    claim,
    sessionId,
    image,
  });
  const targetRevision =
    task.hermesWorkflow === 'bounded-coding'
      ? await resolveDevelopHead(repositoryRoot)
      : undefined;
  const initialWorkspace = await inspectWorktree(
    number,
    task.branch,
    targetRevision,
  );
  if (!initialWorkspace || typeof initialWorkspace.fingerprint !== 'string')
    throw new Error('Trusted restricted workspace inspection failed.');
  if (task.hermesWorkflow === 'bounded-coding') {
    const claimedWorkspace = await inspectRegisteredWorktree(
      repositoryRoot,
      claim,
    );
    if (
      initialWorkspace.clean !== true ||
      !initialWorkspace.headRevision ||
      initialWorkspace.headRevision !== targetRevision ||
      initialWorkspace.baseRevision !== targetRevision ||
      claimedWorkspace.clean !== true ||
      claimedWorkspace.headRevision !== initialWorkspace.headRevision
    )
      throw new Error(
        'Bounded coding requires a clean issue worktree at a verified exact revision.',
      );
  }

  await verifyImageCompatibility({
    image,
    trustedRepositoryRoot: repositoryRoot,
  });

  let preparedContext;
  if (task.hermesWorkflow === 'bounded-coding') {
    preparedContext = buildPeonTaskContextManifest({
      issue,
      task,
      repositoryRoot,
      worktreePath: claim.worktreePath,
      headRevision: initialWorkspace.headRevision,
      contextPlan,
      workspaceIdentity: initialWorkspace.workspacePath,
      workspaceReader: (relativePath) =>
        readWorkspaceFile(number, relativePath),
      protectedPaths: getProtectedPaths(),
    });
    const [
      currentIssue,
      currentClaim,
      currentDevelopHead,
      currentWorkspace,
      currentRegisteredWorkspace,
    ] = await Promise.all([
      loadAssignment(number),
      readClaim(repositoryRoot, number),
      resolveDevelopHead(repositoryRoot),
      inspectWorktree(number, task.branch, targetRevision),
      inspectRegisteredWorktree(repositoryRoot, claim),
    ]);
    validateLivePeonAssignment({
      issue: currentIssue,
      claim: currentClaim,
      sessionId,
      image,
    });
    if (
      freshIssueFingerprint(currentIssue) !== freshIssueFingerprint(issue) ||
      currentClaim.sessionId !== claim.sessionId ||
      currentClaim.branch !== claim.branch ||
      currentClaim.worktreePath !== claim.worktreePath ||
      currentDevelopHead !== targetRevision ||
      currentWorkspace.clean !== true ||
      currentWorkspace.headRevision !== initialWorkspace.headRevision ||
      currentWorkspace.baseRevision !== targetRevision ||
      currentWorkspace.fingerprint !== initialWorkspace.fingerprint ||
      currentRegisteredWorkspace.clean !== true ||
      currentRegisteredWorkspace.headRevision !== initialWorkspace.headRevision
    )
      throw new Error(
        'Trusted issue, claim, or worktree changed during context preparation.',
      );
    reserveAttempt({
      repositoryRoot,
      issueNumber: number,
      sessionId,
      branch: task.branch,
      worktreePath: task.worktreePath,
      revision: initialWorkspace.headRevision,
      requestLimit: task.maxForwardedRequests,
    });
  }

  const worker = createWorkerAdapter({
    image,
    hermesProfile: task.hermesProfile,
    ...(preparedContext ? { preparedContext } : {}),
    ...(task.maxForwardedRequests === null
      ? {}
      : { maxForwardedRequests: task.maxForwardedRequests }),
  });
  const mira = {
    id: 'mira',
    async run() {
      throw new Error('Mira transfer is not authorized by this Peon trial.');
    },
  };
  let activeVerification = null;
  const verify = async ({ task: verifiedTask, attemptNumber = 1 }) => {
    if (verifiedTask.issueNumber !== number)
      throw new Error(
        'Verification issue differs from the validated assignment.',
      );
    const results = [];
    if (verifiedTask.hermesWorkflow === 'bounded-coding') {
      const finalWorkspace = await inspectWorktree(
        number,
        task.branch,
        targetRevision,
      );
      const allowedPaths =
        preparedContext?.manifest?.authorization?.allowedChangePaths;
      const changedPaths = finalWorkspace?.changes ?? [];
      if (
        !Array.isArray(allowedPaths) ||
        changedPaths.length === 0 ||
        changedPaths.some((changed) => !allowedPaths.includes(changed))
      )
        return [
          {
            name: 'authorized-source-changes',
            passed: false,
            summary:
              'The worker produced no authorized source changes or changed a path outside the trusted allowlist.',
          },
        ];
    }
    for (const check of verificationCommands) {
      activeVerification = { issueNumber: number, attemptNumber };
      const outcome = await runVerification({
        issueNumber: number,
        image,
        command: check.command,
        attemptNumber,
      });
      results.push({
        name: check.name,
        passed: outcome.exitCode === 0,
        summary: `Isolated verification exited with code ${outcome.exitCode}.`,
      });
      activeVerification = null;
      if (outcome.exitCode !== 0) break;
    }
    return results;
  };
  verify.cancel = async () => {
    if (!activeVerification) return true;
    return cancelVerification(activeVerification);
  };

  return runSupervisor({
    task,
    workers: { peon: worker, mira },
    inspectWorktree: async (currentTask) => {
      if (
        currentTask.issueNumber !== task.issueNumber ||
        currentTask.branch !== task.branch ||
        currentTask.worktreePath !== task.worktreePath
      )
        throw new Error(
          'Supervisor task differs from the validated issue claim.',
        );
      return inspectWorktree(number, task.branch, targetRevision);
    },
    verify,
    handoffPath,
    limits: { ...defaultLimits, maxAttemptsPerWorker: 1 },
    signal,
  });
}
