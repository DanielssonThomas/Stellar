import path from 'node:path';
import { inspectClaim } from './issue-worktree.mjs';
import { loadIssue } from './manage-issue-worktree.mjs';
import {
  cancelRestrictedVerification,
  createPeonWorkerAdapter,
  inspectRestrictedWorkspace,
  runRestrictedVerification,
} from './run-restricted-worker.mjs';
import { validateFreshIssue } from './update-issue.mjs';
import { defaultLimits, superviseWorker } from './supervise-worker.mjs';

const imagePattern =
  /^ghcr\.io\/stellar-ai-corp\/hermes-worker@sha256:[a-f0-9]{64}$/;
export const trustedPeonWorkerImage =
  'ghcr.io/stellar-ai-corp/hermes-worker@sha256:faf69a7713ae098bce64c75f3d38d6351c38f9733ea98c5b70bfb17f33381d44';

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
  signal,
  loadAssignment = loadIssue,
  readClaim = inspectClaim,
  inspectWorktree = inspectRestrictedWorkspace,
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
  const initialWorkspace = await inspectWorktree(number, task.branch);
  if (!initialWorkspace || typeof initialWorkspace.fingerprint !== 'string')
    throw new Error('Trusted restricted workspace inspection failed.');

  const worker = createWorkerAdapter({ image });
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
      return inspectWorktree(number, task.branch);
    },
    verify,
    handoffPath,
    limits: { ...defaultLimits, maxAttemptsPerWorker: 1 },
    signal,
  });
}
