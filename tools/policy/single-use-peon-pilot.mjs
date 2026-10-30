/** Issue #138 only. No production dispatcher imports this module. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { inspectClaim } from './issue-worktree.mjs';
import { loadIssue } from './manage-issue-worktree.mjs';
import { buildMinimalPeonTaskContextManifest } from './peon-task-context.mjs';
import { preparePrivateSourceCopy } from './prepare-private-source.mjs';
import { collectPrivateCandidate } from './private-candidate.mjs';
import {
  preparePrivatePilotDependencies,
  runPrivateCandidateChecks,
} from './private-candidate-tests.mjs';
import {
  assertTrustedPrivatePilotResult,
  createPeonWorkerAdapter,
  getTrustedProtectedPathsForContext,
  inspectRestrictedWorkspace,
  readRestrictedWorkspaceFile,
  runWorkspaceInspection,
} from './run-restricted-worker.mjs';
import {
  appendMentorFeedback,
  correctionFeedbackFromHandoff,
  defaultLimits,
  readHandoff,
  superviseWorker,
  withCurrentCorrectionFeedback,
} from './supervise-worker.mjs';
import {
  resolveCurrentDevelopHead,
  trustedPeonWorkerImage,
  validateLivePeonAssignment,
} from './supervised-peon-run.mjs';
import { stopAndConfirmContainer } from './worker-container-lifecycle.mjs';

const issueNumber = 138;
const roots = Object.freeze({
  privateRoot: '/home/peon/stellar-private-pilot-source',
  dependencyRoot: '/home/peon/stellar-private-pilot-deps',
  candidateRoot: '/home/peon/stellar-private-pilot-candidates',
  testRoot: '/home/peon/stellar-private-pilot-tests',
  protectedRoot: '/home/peon/stellar-private-pilot-protected',
});
const cacheRoot =
  '/home/peon/stellar-dependency-cache/9f7d2f801be4f1c6bc6b9bea5c6a7a3ffe64e0b7ee69fab9a4a1b3a8cf4b5fc0';
const writablePaths = Object.freeze(['libs/ui/molecules/src']);
const authorizedChangePaths = Object.freeze(['libs/ui/molecules/src']);
const checkNames = Object.freeze([
  'ui-molecules-discovery',
  'ui-molecules-lint',
  'ui-molecules-test',
  'ui-molecules-build',
]);
const maxAttemptBytes = 3 * 1024 ** 3;
const minFreeBytes = 4 * 1024 ** 3;
const hex = /^[a-f0-9]{64}$/;

function statePaths(repositoryRoot) {
  if (!path.isAbsolute(repositoryRoot ?? ''))
    throw new Error('Trusted absolute repository root is required.');
  const root = path.resolve(
    repositoryRoot,
    '..',
    '.stellar-supervisor-state',
    'single-use-pilot-138',
  );
  return {
    root,
    issued: path.join(root, 'issued.json'),
    authorized: path.join(root, 'authorized.json'),
    consumed: path.join(root, 'consumed.json'),
    active: path.join(root, 'active.json'),
    finished: path.join(root, 'finished.json'),
    independentHandoff: path.join(root, 'independent-handoff.json'),
    correctionHandoff: path.join(root, 'correction-handoff.json'),
  };
}

async function writeExclusive(file, value) {
  const encoded = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(encoded, 'utf8') > 8192)
    throw new Error('Pilot state exceeds its trusted byte bound.');
  const handle = await open(file, 'wx', 0o600);
  try {
    await handle.writeFile(encoded, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readState(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function exists(file) {
  return stat(file).then(
    () => true,
    (error) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    },
  );
}

function fingerprint(issue) {
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

async function authority(options, adapters) {
  const issue = await (adapters.loadIssue ?? loadIssue)(issueNumber);
  const claim = await (adapters.inspectClaim ?? inspectClaim)(
    options.repositoryRoot,
    issueNumber,
  );
  const task = validateLivePeonAssignment({
    issue,
    claim,
    sessionId: options.sessionId,
    image: trustedPeonWorkerImage,
  });
  if (
    task.hermesProfile !== 'narrow-coding' ||
    task.hermesWorkflow !== 'minimal-coding'
  )
    throw new Error('Pilot requires the existing narrow coding workflow.');
  const revision = await (
    adapters.resolveDevelopHead ?? resolveCurrentDevelopHead
  )(options.repositoryRoot);
  const source = await (
    adapters.inspectWorkspace ?? inspectRestrictedWorkspace
  )(issueNumber, task.branch, revision);
  if (
    source?.clean !== true ||
    source.headRevision !== revision ||
    source.baseRevision !== revision ||
    !hex.test(source.fingerprint ?? '') ||
    source.workspacePath !== '/home/peon/workspaces/issue-138'
  )
    throw new Error(
      'Pilot source is stale, dirty, or not the claimed checkout.',
    );
  return {
    issue,
    claim,
    task,
    revision,
    source,
    issueDigest: fingerprint(issue),
  };
}

function assertBound(current, authorization) {
  if (
    authorization.schema !== 'stellar.single-use-peon-pilot/v1' ||
    authorization.issueNumber !== issueNumber ||
    authorization.sessionId !== current.claim.sessionId ||
    authorization.branch !== current.claim.branch ||
    authorization.worktreePath !== current.claim.worktreePath ||
    authorization.sourceRevision !== current.revision ||
    authorization.sourceFingerprint !== current.source.fingerprint ||
    authorization.issueDigest !== current.issueDigest ||
    authorization.independentAttemptId !== 'issue-138-attempt-1' ||
    authorization.correctionAttemptId !== 'issue-138-attempt-2' ||
    authorization.feedbackLevel !== 'diagnostic'
  )
    throw new Error('Single-use pilot authorization is stale or substituted.');
}

/** Explicit maintainer action for a later live pilot; never called by dispatch. */
export async function issueSingleUsePilotAuthorization(options, adapters = {}) {
  const current = await authority(options, adapters);
  const paths = statePaths(options.repositoryRoot);
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  const authorization = {
    schema: 'stellar.single-use-peon-pilot/v1',
    id: randomUUID(),
    issueNumber,
    sessionId: current.claim.sessionId,
    branch: current.claim.branch,
    worktreePath: current.claim.worktreePath,
    sourceRevision: current.revision,
    sourceFingerprint: current.source.fingerprint,
    issueDigest: current.issueDigest,
    independentAttemptId: 'issue-138-attempt-1',
    correctionAttemptId: 'issue-138-attempt-2',
    feedbackLevel: 'diagnostic',
    createdAt: new Date().toISOString(),
  };
  // The fixed filename and exclusive create prevent a second authorization.
  await writeExclusive(paths.issued, authorization);
  await writeExclusive(paths.authorized, authorization);
  return Object.freeze(authorization);
}

function measureDisk(runCommand, existing) {
  const free = Number(
    runCommand(['df', '-B1', '--output=avail', roots.privateRoot], {
      timeout: 5_000,
      maxBuffer: 1024,
    })
      .trim()
      .split(/\s+/)
      .at(-1),
  );
  let used = 0;
  for (const location of existing) {
    if (!Object.values(roots).some((root) => location.startsWith(`${root}/`)))
      throw new Error('Pilot disk path escaped fixed attempt roots.');
    if (
      runCommand(['realpath', '-e', location], {
        timeout: 5_000,
        maxBuffer: 1024,
      }).trim() !== location
    )
      throw new Error('Pilot disk path was substituted.');
    used += Number(
      runCommand(['du', '-sb', '--', location], {
        timeout: 10_000,
        maxBuffer: 1024,
      })
        .trim()
        .split(/\s+/)[0],
    );
  }
  if (
    !Number.isSafeInteger(used) ||
    !Number.isSafeInteger(free) ||
    used > maxAttemptBytes ||
    free < minFreeBytes
  )
    throw new Error('Pilot disk budget or free-space floor exceeded.');
  return { usedBytes: used, freeBytes: free };
}

function contextPlan(feedback) {
  return {
    skills: ['.agents/skills/create-component/SKILL.md'],
    files: [
      {
        kind: 'source',
        path: 'libs/ui/molecules/src/index.ts',
        startLine: 1,
        endLine: 1,
      },
      {
        kind: 'source',
        path: 'libs/ui/atoms/src/lib/atoms/skeleton-atom.component.ts',
        startLine: 1,
        endLine: 19,
      },
    ],
    authorizedChangePaths: [...writablePaths],
    ...(feedback ? { mentorFeedback: feedback } : {}),
  };
}

async function assertCurrent(options, adapters, authorization) {
  const current = await authority(options, adapters);
  assertBound(current, authorization);
  return current;
}

async function runAttempt(
  options,
  adapters,
  authorization,
  attemptNumber,
  feedback,
  attemptLimits,
  knownDiskPaths,
  signal,
) {
  const runCommand = adapters.runCommand ?? runWorkspaceInspection;
  const current = await assertCurrent(options, adapters, authorization);
  const attemptId = `issue-138-attempt-${attemptNumber}`;
  const protectedPaths = (
    adapters.getProtectedPaths ?? getTrustedProtectedPathsForContext
  )();
  const copy = await (adapters.prepareSource ?? preparePrivateSourceCopy)({
    issueNumber,
    attemptId,
    workspace: current.source.workspacePath,
    privateRoot: roots.privateRoot,
    expectedBranch: current.task.branch,
    expectedRevision: current.revision,
    expectedFingerprint: current.source.fingerprint,
    authorizedChangePaths: [...authorizedChangePaths],
    protectedPaths,
    signal,
    runCommand,
    inspectWorkspace: adapters.inspectWorkspace ?? inspectRestrictedWorkspace,
  });
  const privatePath = path.posix.join(roots.privateRoot, attemptId);
  knownDiskPaths.push(privatePath);
  measureDisk(runCommand, knownDiskPaths);
  const uid = Number(
    runCommand(['id', '-u'], { timeout: 5_000, maxBuffer: 128 }),
  );
  const gid = Number(
    runCommand(['id', '-g'], { timeout: 5_000, maxBuffer: 128 }),
  );
  if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid))
    throw new Error('Trusted Peon UID/GID could not be measured.');
  const protectedRoot = path.posix.join(roots.protectedRoot, attemptId);
  runCommand(['mkdir', '-m', '700', '--', protectedRoot], {
    timeout: 5_000,
    maxBuffer: 1024,
  });
  for (const item of protectedPaths) {
    const destination = path.posix.join(protectedRoot, item);
    runCommand(['mkdir', '-p', '--', path.posix.dirname(destination)], {
      timeout: 5_000,
      maxBuffer: 1024,
    });
    const sourcePath = `${current.source.workspacePath}/${item}`;
    if (
      runCommand(['realpath', '-e', sourcePath], {
        timeout: 5_000,
        maxBuffer: 1024,
      }).trim() !== sourcePath
    )
      throw new Error('Trusted protected source path changed.');
    runCommand(['cp', '-a', '--', sourcePath, destination], {
      timeout: 15_000,
      maxBuffer: 1024,
    });
  }
  await assertCurrent(options, adapters, authorization);
  knownDiskPaths.push(protectedRoot);
  measureDisk(runCommand, knownDiskPaths);
  const dependencyOptions = {
    issueNumber,
    attemptNumber,
    privateRoot: roots.privateRoot,
    candidateRoot: roots.candidateRoot,
    trustedProtectedRoot: protectedRoot,
    testRoot: roots.dependencyRoot,
    cacheRoot,
    protectedPaths,
    uid,
    gid,
    signal,
  };
  const dependency = await (
    adapters.prepareDependencies ?? preparePrivatePilotDependencies
  )(dependencyOptions, copy);
  knownDiskPaths.push(path.posix.join(roots.dependencyRoot, attemptId));
  measureDisk(runCommand, knownDiskPaths);
  await assertCurrent(options, adapters, authorization);
  const preparedContext = (
    adapters.buildContext ?? buildMinimalPeonTaskContextManifest
  )({
    issue: current.issue,
    task: current.task,
    worktreePath: current.claim.worktreePath,
    contextPlan: contextPlan(feedback),
    workspaceReader: (name) =>
      (adapters.readWorkspaceFile ?? readRestrictedWorkspaceFile)(
        issueNumber,
        name,
      ),
    protectedPaths,
  });
  const privateSource = {
    privateCopy: copy,
    privateRoot: roots.privateRoot,
    expectedRevision: current.revision,
    expectedFingerprint: current.source.fingerprint,
    expectedDigest: copy.contentDigest,
    trustedProtectedRoot: protectedRoot,
    dependencyRoot: dependency.dependencyRoot,
  };
  const baseWorker = (adapters.createWorkerAdapter ?? createPeonWorkerAdapter)({
    image: trustedPeonWorkerImage,
    hermesProfile: 'narrow-coding',
    preparedContext,
    privatePilot: {
      attemptNumber,
      privateSource,
      feedback,
      limits: attemptLimits,
    },
  });
  let lastResult;
  const worker = {
    ...baseWorker,
    async run(context) {
      await assertCurrent(options, adapters, authorization);
      measureDisk(runCommand, knownDiskPaths);
      lastResult = await baseWorker.run(context);
      return lastResult;
    },
  };
  const candidateOptions = {
    issueNumber,
    attemptNumber,
    privateCopy: copy,
    privateRoot: roots.privateRoot,
    candidateRoot: roots.candidateRoot,
    trustedProtectedRoot: protectedRoot,
    testRoot: roots.testRoot,
    expectedRevision: current.revision,
    expectedFingerprint: current.source.fingerprint,
    expectedBaselineDigest: copy.contentDigest,
    authorizedChangePaths: [...authorizedChangePaths],
    protectedPaths,
    uid,
    gid,
    cacheRoot,
    checkNames: [...checkNames],
    signal,
  };
  let candidate;
  let checks;
  const verificationAbort = new AbortController();
  const verify = async ({ result, signal: verificationSignal }) => {
    (adapters.assertTrustedResult ?? assertTrustedPrivatePilotResult)(
      result,
      attemptId,
      copy.contentDigest,
    );
    await assertCurrent(options, adapters, authorization);
    const verificationCombined = verificationSignal
      ? AbortSignal.any(
          [
            signal,
            verificationSignal,
            verificationAbort.signal,
            meterAbort.signal,
          ].filter(Boolean),
        )
      : AbortSignal.any(
          [signal, verificationAbort.signal, meterAbort.signal].filter(Boolean),
        );
    candidate = await (adapters.collect ?? collectPrivateCandidate)({
      ...candidateOptions,
      workerCompletion: Promise.resolve(result),
      signal: verificationCombined,
    });
    if (
      candidate?.attemptId !== attemptId ||
      candidate.sourceRevision !== current.revision ||
      candidate.sourceFingerprint !== current.source.fingerprint ||
      candidate.baselineDigest !== copy.contentDigest ||
      !hex.test(candidate.contentDigest ?? '') ||
      !Array.isArray(candidate.changes) ||
      candidate.changes.length === 0 ||
      candidate.changes.some(
        (name) => !name.startsWith('libs/ui/molecules/src/'),
      )
    )
      throw new Error(
        'Candidate output is missing or belongs to another attempt.',
      );
    knownDiskPaths.push(path.posix.join(roots.candidateRoot, attemptId));
    measureDisk(runCommand, knownDiskPaths);
    checks = await (adapters.runChecks ?? runPrivateCandidateChecks)(
      { ...candidateOptions, signal: verificationCombined },
      candidate,
    );
    knownDiskPaths.push(path.posix.join(roots.testRoot, attemptId));
    measureDisk(runCommand, knownDiskPaths);
    await assertCurrent(options, adapters, authorization);
    if (
      checks?.candidateDigest !== candidate.contentDigest ||
      checks.integrity !== 'verified'
    )
      throw new Error('Exact changed candidate verification is absent.');
    return checkNames.map((name) => ({
      name,
      passed:
        checks.status === 'tests-passed' &&
        checks.checks?.some(
          (entry) => entry.name === name && entry.exitCode === 0,
        ),
      summary: `Exact private candidate check: ${name}.`,
    }));
  };
  verify.cancel = async () => {
    verificationAbort.abort();
    const stopped = await (
      adapters.confirmTermination ?? stopAndConfirmContainer
    )(`stellar-peon-verify-138-${attemptNumber}`);
    return (
      stopped?.confirmed === true &&
      ['absent', 'stopped'].includes(stopped.state)
    );
  };
  const meterAbort = new AbortController();
  const combined = signal
    ? AbortSignal.any([signal, meterAbort.signal])
    : meterAbort.signal;
  let diskFailure = null;
  const monitor = setInterval(() => {
    try {
      measureDisk(runCommand, knownDiskPaths);
    } catch (error) {
      diskFailure = error;
      meterAbort.abort();
    }
  }, 750);
  const handoffPath =
    attemptNumber === 1
      ? statePaths(options.repositoryRoot).independentHandoff
      : statePaths(options.repositoryRoot).correctionHandoff;
  try {
    const supervised = await (adapters.runSupervisor ?? superviseWorker)({
      task: current.task,
      workers: {
        peon: worker,
        mira: {
          id: 'mira',
          async run() {
            throw new Error('Mira is not authorized for the #138 pilot.');
          },
        },
      },
      inspectWorktree: async () =>
        (await assertCurrent(options, adapters, authorization)).source,
      verify,
      handoffPath,
      limits: { ...attemptLimits, maxAttemptsPerWorker: 1 },
      signal: combined,
    });
    if (diskFailure) throw diskFailure;
    if (lastResult)
      (adapters.assertTrustedResult ?? assertTrustedPrivatePilotResult)(
        lastResult,
        attemptId,
        copy.contentDigest,
      );
    const disk = measureDisk(runCommand, knownDiskPaths);
    return { supervised, candidate, checks, disk, lastResult, handoffPath };
  } finally {
    clearInterval(monitor);
  }
}

function attemptSummary(attempt) {
  if (!attempt) return null;
  return {
    status: attempt.supervised.status,
    attribution:
      attempt.supervised.status === 'complete'
        ? 'peon-metered-private'
        : 'peon-stopped-failure',
    candidateDigest: attempt.candidate?.contentDigest ?? null,
    changedFiles: attempt.candidate?.changes ?? [],
    repositoryChecks: attempt.checks?.status ?? 'not-run',
    testEvidencePath: attempt.checks
      ? path.posix.join(
          roots.testRoot,
          attempt.candidate.attemptId,
          'evidence.json',
        )
      : null,
    usage: attempt.supervised.handoff.workerUsage.peon,
    failure: attempt.supervised.handoff.failures.at(-1)?.message ?? null,
    disk: attempt.disk,
  };
}

async function finish(
  paths,
  status,
  independent,
  correction = null,
  feedback = null,
) {
  const active = await readState(paths.active);
  const consumed = await readState(paths.consumed);
  if (
    active.schema !== 'stellar.single-use-peon-pilot-active/v1' ||
    active.authorizationId !== consumed.id ||
    !Number.isFinite(Date.parse(active.startedAt))
  )
    throw new Error('Active pilot state changed before completion.');
  const outcome = {
    schema: 'stellar.single-use-peon-pilot-result/v1',
    status,
    independent: attemptSummary(independent),
    correction: attemptSummary(correction),
    mentorContribution: feedback
      ? { level: feedback.level, diagnostic: feedback.diagnostic }
      : null,
    publication: 'manual-inspection-required',
    wallTimeMs: Math.max(0, Date.now() - Date.parse(active.startedAt)),
    finishedAt: new Date().toISOString(),
  };
  await writeExclusive(path.join(paths.root, 'outcome.json'), outcome);
  await rename(paths.active, paths.finished);
  return outcome;
}

/** Reclaim only disposable inputs after the exact attempt has safely stopped. */
function releaseDisposableInputs(
  runCommand,
  attempt,
  attemptNumber,
  knownDiskPaths,
) {
  if (
    !attempt?.lastResult?.pilotEvidence ||
    !['complete', 'handoff-pending'].includes(attempt.supervised.status)
  )
    throw new Error(
      'Disposable cleanup requires confirmed attempt termination.',
    );
  const attemptId = `issue-138-attempt-${attemptNumber}`;
  const removable = [path.posix.join(roots.dependencyRoot, attemptId)];
  if (attempt.checks)
    removable.push(
      path.posix.join(roots.testRoot, attemptId, 'workspace'),
      path.posix.join(roots.testRoot, attemptId, 'store'),
    );
  for (const target of removable) {
    const parent = path.posix.dirname(target);
    if (
      !Object.values(roots).some(
        (root) => parent === root || parent.startsWith(`${root}/`),
      ) ||
      runCommand(['realpath', '-e', target], {
        timeout: 5_000,
        maxBuffer: 1024,
      }).trim() !== target
    )
      throw new Error('Disposable cleanup target changed.');
    runCommand(['rm', '-rf', '--', target], {
      timeout: 30_000,
      maxBuffer: 1024,
    });
  }
  const dependencyAttempt = path.posix.join(roots.dependencyRoot, attemptId);
  const index = knownDiskPaths.indexOf(dependencyAttempt);
  if (index < 0) throw new Error('Disposable dependency identity was lost.');
  knownDiskPaths.splice(index, 1);
}

/** Consumes the fixed authorization before any worker can start. */
export async function runSingleUsePeonPilot(options, adapters = {}) {
  const paths = statePaths(options.repositoryRoot);
  if (options.signal?.aborted) throw new Error('Pilot was cancelled.');
  if (await exists(paths.consumed))
    throw new Error('Single-use pilot authorization was already consumed.');
  const authorization = await readState(paths.authorized);
  const issued = await readState(paths.issued);
  if (JSON.stringify(authorization) !== JSON.stringify(issued))
    throw new Error('Issued pilot authorization was substituted.');
  const current = await assertCurrent(options, adapters, authorization);
  const active = {
    schema: 'stellar.single-use-peon-pilot-active/v1',
    authorizationId: authorization.id,
    sessionId: current.claim.sessionId,
    status: 'consuming',
    startedAt: new Date().toISOString(),
  };
  await writeExclusive(paths.active, active);
  await rename(paths.authorized, paths.consumed);
  const knownDiskPaths = [];
  const runCommand = adapters.runCommand ?? runWorkspaceInspection;
  try {
    for (const root of Object.values(roots)) {
      runCommand(['mkdir', '-p', '-m', '700', '--', root], {
        timeout: 5_000,
        maxBuffer: 1024,
      });
      if (
        runCommand(['realpath', '-e', root], {
          timeout: 5_000,
          maxBuffer: 1024,
        }).trim() !== root ||
        runCommand(['stat', '-c', '%u:%a', '--', root], {
          timeout: 5_000,
          maxBuffer: 1024,
        }).trim() !==
          `${runCommand(['id', '-u'], { timeout: 5_000, maxBuffer: 128 }).trim()}:700`
      )
        throw new Error('Pilot root changed.');
    }
    measureDisk(runCommand, knownDiskPaths);
    const independent = await runAttempt(
      options,
      adapters,
      authorization,
      1,
      null,
      defaultLimits,
      knownDiskPaths,
      options.signal,
    );
    if (independent.supervised.status === 'complete') {
      releaseDisposableInputs(runCommand, independent, 1, knownDiskPaths);
      await assertCurrent(options, adapters, authorization);
      return finish(paths, 'independent-peon-success', independent);
    }
    if (
      independent.supervised.status !== 'handoff-pending' ||
      !independent.lastResult?.pilotEvidence ||
      independent.supervised.handoff.safeToResume !== true
    )
      throw new Error(
        'Independent attempt did not stop with eligible evidence.',
      );
    const handoff = await readHandoff(paths.independentHandoff);
    const attempt = handoff.attempts.at(-1);
    if (
      !['WorkerExit', 'VerificationFailed'].includes(attempt?.failure?.code) ||
      (attempt.failure.code === 'VerificationFailed' &&
        (independent.checks?.status !== 'tests-failed' ||
          !independent.candidate))
    )
      throw new Error(
        'Stopped failure is not eligible for this pilot correction.',
      );
    const used = handoff.workerUsage?.peon;
    const remaining = {
      ...defaultLimits,
      maxModelTokensPerWorker:
        defaultLimits.maxModelTokensPerWorker - (used?.modelTokens ?? Infinity),
      maxToolCallsPerWorker:
        defaultLimits.maxToolCallsPerWorker - (used?.toolCalls ?? Infinity),
      maxRuntimeMsPerWorker:
        defaultLimits.maxRuntimeMsPerWorker - (used?.runtimeMs ?? Infinity),
    };
    if (
      !Number.isSafeInteger(remaining.maxModelTokensPerWorker) ||
      remaining.maxModelTokensPerWorker < 1 ||
      !Number.isSafeInteger(remaining.maxToolCallsPerWorker) ||
      remaining.maxToolCallsPerWorker < 1 ||
      !Number.isSafeInteger(remaining.maxRuntimeMsPerWorker) ||
      remaining.maxRuntimeMsPerWorker < 1
    )
      throw new Error('No trusted pilot budget remains for correction.');
    releaseDisposableInputs(runCommand, independent, 1, knownDiskPaths);
    measureDisk(runCommand, knownDiskPaths);
    const failedIndex = attempt?.verificationResults?.findIndex(
      (entry) => entry.passed === false,
    );
    const cited = attempt?.failure
      ? { kind: 'failure' }
      : Number.isSafeInteger(failedIndex) && failedIndex >= 0
        ? { kind: 'verification', index: failedIndex }
        : null;
    if (!cited || attempt.attemptNumber !== 1)
      throw new Error('Stopped Peon failure evidence is not eligible.');
    await (adapters.appendFeedback ?? appendMentorFeedback)({
      handoffPath: paths.independentHandoff,
      issueNumber,
      attemptNumber: 1,
      expectedUpdatedAt: handoff.updatedAt,
      expectedFingerprint: attempt.afterFingerprint,
      level: 'diagnostic',
      evidence: cited,
      inspectWorktree: async () =>
        (await assertCurrent(options, adapters, authorization)).source,
    });
    const feedback = await (
      adapters.feedbackFromHandoff ?? correctionFeedbackFromHandoff
    )({
      handoffPath: paths.independentHandoff,
      issueNumber,
      inspectWorktree: async () =>
        (await assertCurrent(options, adapters, authorization)).source,
    });
    const correction = await withCurrentCorrectionFeedback(
      feedback,
      {
        issueNumber,
        destinationHandoffPath: paths.correctionHandoff,
      },
      async (assertFeedbackCurrent) => {
        await assertFeedbackCurrent(current.task, current.source);
        const result = await runAttempt(
          options,
          adapters,
          authorization,
          2,
          feedback,
          remaining,
          knownDiskPaths,
          options.signal,
        );
        await assertFeedbackCurrent(current.task, current.source);
        return result;
      },
    );
    if (
      !['complete', 'handoff-pending'].includes(correction.supervised.status) ||
      correction.supervised.handoff.safeToResume !== true
    )
      throw new Error('Correction termination or verification is uncertain.');
    releaseDisposableInputs(runCommand, correction, 2, knownDiskPaths);
    await assertCurrent(options, adapters, authorization);
    return finish(
      paths,
      correction.supervised.status === 'complete'
        ? 'assisted-peon-success'
        : 'peon-correction-failed',
      independent,
      correction,
      feedback,
    );
  } catch (error) {
    // active.json and consumed.json deliberately survive ambiguous outcomes.
    throw error;
  }
}

/** Manual recovery never restores the consumed authorization. */
export async function recoverSingleUsePeonPilot({
  repositoryRoot,
  confirmSupervisorStopped,
  confirmTermination = stopAndConfirmContainer,
}) {
  if (typeof confirmSupervisorStopped !== 'function')
    throw new Error('Trusted supervisor termination proof is required.');
  const paths = statePaths(repositoryRoot);
  const active = await readState(paths.active);
  if (
    active.schema !== 'stellar.single-use-peon-pilot-active/v1' ||
    !(await confirmSupervisorStopped(active))
  )
    throw new Error('Pilot supervisor termination is uncertain.');
  for (const attempt of [1, 2]) {
    for (const prefix of [
      'stellar-peon-worker',
      'stellar-peon-meter',
      'stellar-peon-verify',
    ]) {
      const stopped = await confirmTermination(`${prefix}-138-${attempt}`);
      if (!stopped?.confirmed || !['absent', 'stopped'].includes(stopped.state))
        throw new Error('Pilot container termination is uncertain.');
    }
  }
  if (await exists(paths.authorized)) {
    if (await exists(paths.consumed))
      throw new Error('Pilot authorization state is ambiguous.');
    await rename(paths.authorized, paths.consumed);
  }
  await rename(paths.active, path.join(paths.root, 'recovered.json'));
  return { recovered: true, authorizationConsumed: true };
}
