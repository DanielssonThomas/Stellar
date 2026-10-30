/** Inert-only composition of the existing private correction components. */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  open,
  mkdir,
  readFile,
  realpath,
  rename,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectClaim } from './issue-worktree.mjs';
import { loadIssue } from './manage-issue-worktree.mjs';
import { preparePrivateSourceCopy } from './prepare-private-source.mjs';
import {
  buildPrivatePodmanArgs,
  captureBoundedDiagnosticStream,
  inspectRestrictedWorkspace,
  runWorkspaceInspection,
} from './run-restricted-worker.mjs';
import { collectPrivateCandidate } from './private-candidate.mjs';
import { runPrivateCandidateChecks } from './private-candidate-tests.mjs';
import {
  correctionFeedbackFromHandoff,
  readHandoff,
  recordInertCorrectionResult,
  withCurrentCorrectionFeedback,
} from './supervise-worker.mjs';
import { trustedPeonWorkerImage } from './supervised-peon-run.mjs';
import {
  createRootlessContainerOperations,
  stopAndConfirmContainer,
} from './worker-container-lifecycle.mjs';

const maxAttemptBytes = 3 * 1024 ** 3;
const minimumFreeBytes = 4 * 1024 ** 3;
const maxInertRuntimeMs = 90_000;
const attemptPattern = /^issue-([1-9][0-9]*)-attempt-([1-9][0-9]*)$/;
const digestPattern = /^[a-f0-9]{64}$/;
const inertCode = `import pathlib,sys,time
mode,relative=sys.argv[1:]
if mode == 'unchanged': raise SystemExit(0)
if mode == 'sleep': time.sleep(120); raise SystemExit(0)
p=pathlib.Path('/workspace')/relative
if mode == 'failed-test':
  p.write_text(p.read_text(encoding='utf-8')+"\\nit('inert failure', () => { throw new Error('inert failure'); });\\n",encoding='utf-8')
else:
  p.write_text('inert simulation\\n',encoding='utf-8')
if mode == 'worker-failure': raise SystemExit(17)`;

function safeRoot(value) {
  return (
    typeof value === 'string' &&
    path.posix.isAbsolute(value) &&
    path.posix.normalize(value) === value &&
    value.startsWith('/home/peon/') &&
    !/[\\,:=\x00-\x1f\x7f]/.test(value)
  );
}

function overlaps(a, b) {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function safeRelative(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= 512 &&
    !/[\\,:=\x00-\x1f\x7f]/.test(value) &&
    value
      .split('/')
      .every((part) => part && part !== '.' && part !== '..' && part !== '.git')
  );
}

function statePaths(repositoryRoot) {
  if (!path.isAbsolute(repositoryRoot ?? ''))
    throw new Error('Trusted repository root is required.');
  const root = path.resolve(
    repositoryRoot,
    '..',
    '.stellar-supervisor-state',
    'inert-correction',
  );
  return { root, active: path.join(root, 'active.json') };
}

async function atomicJson(file, value) {
  const text = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(text, 'utf8') > 8192)
    throw new Error('Inert attempt record exceeds its bound.');
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function reserveAttempt(repositoryRoot, record) {
  const { root, active } = statePaths(repositoryRoot);
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (path.resolve(await realpath(root)) !== root)
    throw new Error('Inert attempt state root changed.');
  const handle = await open(active, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  const journal = path.join(root, `${record.attemptId}.json`);
  const duplicate = await access(journal)
    .then(() => true)
    .catch((error) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });
  if (duplicate) {
    await unlink(active);
    throw new Error('Duplicate inert attempt identity is already journaled.');
  }
  await atomicJson(journal, record);
  return { root, active };
}

async function updateAttempt(paths, record, status, detail = {}) {
  const next = {
    ...record,
    ...detail,
    status,
    updatedAt: new Date().toISOString(),
  };
  await atomicJson(path.join(paths.root, `${record.attemptId}.json`), next);
  return next;
}

async function releaseAttempt(paths, record) {
  const active = await readJson(paths.active);
  if (
    active.attemptId !== record.attemptId ||
    active.issueNumber !== record.issueNumber ||
    active.sessionId !== record.sessionId
  )
    throw new Error('Active inert attempt identity changed.');
  await unlink(paths.active);
}

function numericOutput(value) {
  const number = Number(String(value).trim());
  if (!Number.isSafeInteger(number) || number < 0)
    throw new Error('Invalid disk measurement.');
  return number;
}

/** Measure only the exact attempt directories, never worker-supplied paths. */
export function measureInertAttemptDisk({
  privateRoot,
  candidateRoot,
  testRoot,
  attemptId,
  existing = [],
  runCommand = runWorkspaceInspection,
}) {
  if (
    !attemptPattern.test(attemptId ?? '') ||
    [privateRoot, candidateRoot, testRoot].some((root) => !safeRoot(root)) ||
    overlaps(privateRoot, candidateRoot) ||
    overlaps(privateRoot, testRoot) ||
    overlaps(candidateRoot, testRoot) ||
    [privateRoot, candidateRoot, testRoot].some((root) =>
      overlaps(root, '/home/peon/workspaces'),
    ) ||
    !Array.isArray(existing) ||
    existing.some(
      (name) => !['privateRoot', 'candidateRoot', 'testRoot'].includes(name),
    )
  )
    throw new Error('Exact private disk roots are required.');
  const roots = { privateRoot, candidateRoot, testRoot };
  const free = numericOutput(
    runCommand(['df', '-B1', '--output=avail', privateRoot], {
      timeout: 5000,
      maxBuffer: 1024,
    })
      .trim()
      .split(/\s+/)
      .at(-1),
  );
  let used = 0;
  for (const name of existing) {
    const target = path.posix.join(roots[name], attemptId);
    if (
      runCommand(['realpath', '-e', target], {
        timeout: 5000,
        maxBuffer: 1024,
      }).trim() !== target
    )
      throw new Error('Attempt disk path changed.');
    used += numericOutput(
      runCommand(['du', '-sb', '--', target], {
        timeout: 10_000,
        maxBuffer: 1024,
      })
        .trim()
        .split(/\s+/)[0],
    );
  }
  if (used > maxAttemptBytes || free < minimumFreeBytes)
    throw new Error(
      'Private attempt disk budget or free-space floor exceeded.',
    );
  return {
    usedBytes: used,
    freeBytes: free,
    maxAttemptBytes,
    minimumFreeBytes,
  };
}

/** Build a fixed Python simulation, with no model network or worker secret. */
export function buildInertPrivateArgs(mount, mode, editPath) {
  if (
    ![
      'success',
      'worker-failure',
      'failed-test',
      'unchanged',
      'sleep',
    ].includes(mode) ||
    !safeRelative(editPath) ||
    !mount?.args?.includes(trustedPeonWorkerImage)
  )
    throw new Error('Only a fixed inert worker command is allowed.');
  const imageIndex = mount.args.indexOf(trustedPeonWorkerImage);
  if (
    mount.args.some(
      (item) =>
        item.startsWith('--secret=') ||
        item.includes('src=/home/peon/workspaces/'),
    )
  )
    throw new Error(
      'Inert worker cannot receive credentials or authoritative mounts.',
    );
  const flags = mount.args
    .slice(0, imageIndex)
    .filter(
      (item) =>
        !item.startsWith('--network=') &&
        !item.startsWith('--env=OPENAI_') &&
        !item.startsWith('--env=HTTP_') &&
        !item.startsWith('--env=HTTPS_') &&
        !item.startsWith('--env=http_') &&
        !item.startsWith('--env=https_') &&
        !item.startsWith('--env=NO_PROXY') &&
        !item.startsWith('--secret='),
    );
  if (
    !flags.includes('--read-only') ||
    !flags.includes('--cap-drop=all') ||
    !flags.includes('--pull=never') ||
    !flags.some((item) =>
      item.includes(`src=${mount.workspace},dst=/workspace,ro`),
    )
  )
    throw new Error('Restricted private worker mount changed.');
  return Object.freeze([
    ...flags,
    '--network=none',
    '--entrypoint=python3',
    trustedPeonWorkerImage,
    '-I',
    '-c',
    inertCode,
    mode,
    editPath,
  ]);
}

async function launchInertWorker(
  args,
  { name, signal, timeoutMs = maxInertRuntimeMs },
) {
  return new Promise((resolve) => {
    const child = spawn(
      'wsl.exe',
      [
        '--distribution',
        'Ubuntu',
        '--user',
        'peon',
        '--exec',
        'podman',
        ...args,
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const stdout = captureBoundedDiagnosticStream(child.stdout);
    const stderr = captureBoundedDiagnosticStream(child.stderr);
    let settled = false;
    let cancelled = false;
    let timedOut = false;
    let shutdownTimer;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(shutdownTimer);
      signal?.removeEventListener('abort', cancel);
      resolve({
        ...value,
        diagnostics: { stdout: stdout(), stderr: stderr() },
      });
    };
    const cancel = () => {
      cancelled = true;
      child.kill();
      shutdownTimer ??= setTimeout(
        () =>
          finish({
            exitCode: null,
            cancelled,
            timedOut,
            error: 'Launcher exit unconfirmed.',
          }),
        5000,
      );
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      shutdownTimer ??= setTimeout(
        () =>
          finish({
            exitCode: null,
            cancelled,
            timedOut,
            error: 'Launcher exit unconfirmed.',
          }),
        5000,
      );
    }, timeoutMs);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    child.once('error', (error) =>
      finish({ exitCode: null, error: error.message }),
    );
    child.once('close', (exitCode, exitSignal) =>
      finish({ exitCode, signal: exitSignal, cancelled, timedOut }),
    );
  });
}

function assertAuthority(authority, options, task) {
  const labels = (authority?.issue?.labels ?? []).map((item) =>
    typeof item === 'string' ? item : item.name,
  );
  const claim = authority?.claim;
  if (
    authority.issue?.number !== options.issueNumber ||
    authority.issue?.state !== 'OPEN' ||
    !labels.includes('status:in-progress') ||
    !labels.includes(task.owner) ||
    !labels.includes(`target:${task.targetBranch}`) ||
    authority.issue?.dependencies?.some(
      (dependency) =>
        dependency.state !== 'CLOSED' || dependency.status !== 'status:done',
    ) ||
    claim?.state !== 'active' ||
    !Number.isFinite(Date.parse(claim?.expiresAt ?? '')) ||
    Date.parse(claim.expiresAt) <= Date.now() ||
    claim.worker !== task.owner ||
    claim.sessionId !== options.sessionId ||
    claim.branch !== task.branch ||
    claim.target !== task.targetBranch ||
    claim.worktreePath !== task.worktreePath
  )
    throw new Error('Issue ownership or active claim is stale.');
}

async function currentAuthority(options, adapters) {
  return adapters.inspectAuthority
    ? adapters.inspectAuthority(options)
    : {
        issue: loadIssue(options.issueNumber),
        claim: await inspectClaim(options.repositoryRoot, options.issueNumber),
      };
}

/** This entry point is inert by construction; it has no production dispatcher caller. */
export async function runInertPrivateCorrection(options, adapters = {}) {
  const {
    repositoryRoot,
    issueNumber,
    sessionId,
    handoffPath,
    sourceWorkspace,
    privateRoot,
    candidateRoot,
    testRoot,
    trustedProtectedRoot,
    authorizedChangePaths,
    protectedPaths,
    writablePaths,
    editPath,
    hermesConfigSource,
    minimalGuidanceSource,
    cacheRoot,
    checkNames,
    mode = 'success',
    signal,
  } = options;
  if (
    !path.isAbsolute(repositoryRoot ?? '') ||
    !path.isAbsolute(handoffPath ?? '') ||
    !Number.isSafeInteger(issueNumber) ||
    issueNumber < 1 ||
    typeof sessionId !== 'string' ||
    !sessionId ||
    !safeRoot(sourceWorkspace) ||
    !safeRoot(privateRoot) ||
    !safeRoot(candidateRoot) ||
    !safeRoot(testRoot) ||
    !safeRoot(trustedProtectedRoot) ||
    [privateRoot, candidateRoot, testRoot, trustedProtectedRoot].some((root) =>
      overlaps(sourceWorkspace, root),
    ) ||
    [privateRoot, candidateRoot, testRoot].some((root) =>
      overlaps(trustedProtectedRoot, root),
    ) ||
    !safeRelative(editPath) ||
    !Array.isArray(authorizedChangePaths) ||
    !authorizedChangePaths.every(safeRelative) ||
    !authorizedChangePaths.some(
      (p) => editPath === p || editPath.startsWith(`${p}/`),
    ) ||
    !Array.isArray(protectedPaths) ||
    !protectedPaths.length ||
    !protectedPaths.every(safeRelative) ||
    !Array.isArray(writablePaths) ||
    !writablePaths.every(safeRelative) ||
    !writablePaths.some((p) => editPath.startsWith(`${p}/`)) ||
    !Array.isArray(checkNames) ||
    !checkNames.length ||
    !safeRoot(cacheRoot) ||
    overlaps(cacheRoot, '/home/peon/workspaces') ||
    [
      sourceWorkspace,
      privateRoot,
      candidateRoot,
      testRoot,
      trustedProtectedRoot,
    ].some((root) => overlaps(cacheRoot, root)) ||
    ![
      'success',
      'worker-failure',
      'failed-test',
      'unchanged',
      'sleep',
    ].includes(mode) ||
    signal?.aborted
  )
    throw new Error('Trusted inert correction options are required.');
  const runCommand = adapters.runCommand ?? runWorkspaceInspection;
  const inspectWorkspace =
    adapters.inspectWorkspace ??
    ((number, branch) =>
      inspectRestrictedWorkspace(number, branch, undefined, {
        workspace: sourceWorkspace,
        runCommand,
      }));
  const inspectWorktree = async (task) =>
    inspectWorkspace(task.issueNumber, task.branch);
  const feedback = await correctionFeedbackFromHandoff({
    handoffPath,
    issueNumber,
    inspectWorktree,
  });
  const handoff = await readHandoff(handoffPath);
  const task = handoff.task;
  const attemptNumber = feedback.attemptNumber + 1;
  const attemptId = `issue-${issueNumber}-attempt-${attemptNumber}`;
  const workerName = `stellar-peon-worker-${issueNumber}-${attemptNumber}`;
  const inspectContainer =
    adapters.inspectContainer ??
    ((name) => createRootlessContainerOperations().inspect(name, 5000));
  const confirmTermination =
    adapters.confirmTermination ?? stopAndConfirmContainer;
  const launchWorker = adapters.launchWorker ?? launchInertWorker;
  const prepareSource = adapters.prepareSource ?? preparePrivateSourceCopy;
  const collect = adapters.collect ?? collectPrivateCandidate;
  const runChecks = adapters.runChecks ?? runPrivateCandidateChecks;
  const budgetAbort = new AbortController();
  const lifecycleSignal = signal
    ? AbortSignal.any([signal, budgetAbort.signal])
    : budgetAbort.signal;
  let paths;
  let record;
  let candidateDigest = 'none';
  let disk = null;
  let diskError = null;
  try {
    const result = await withCurrentCorrectionFeedback(
      feedback,
      { issueNumber },
      async (assertCurrent) => {
        assertAuthority(
          await currentAuthority(options, adapters),
          options,
          task,
        );
        const current = await inspectWorktree(task);
        const sourceFingerprint = current.fingerprint;
        if (
          !/^[a-f0-9]{40,64}$/.test(current.headRevision ?? '') ||
          createHash('sha256')
            .update(sourceFingerprint ?? '')
            .digest('hex') !== feedback.fingerprint
        )
          throw new Error(
            'Correction source revision or fingerprint is stale.',
          );
        const expectedRevision = current.headRevision;
        if (
          !['absent', 'stopped'].includes(
            await inspectContainer(
              `stellar-peon-worker-${issueNumber}-${feedback.attemptNumber}`,
            ),
          )
        )
          throw new Error('Prior Peon worker termination is unconfirmed.');
        disk = measureInertAttemptDisk({
          privateRoot,
          candidateRoot,
          testRoot,
          attemptId,
          runCommand,
        });
        if ((await inspectContainer(workerName)) !== 'absent')
          throw new Error('Exact inert worker container is already present.');
        record = {
          schema: 'stellar.inert-private-attempt/v1',
          issueNumber,
          sessionId,
          ownerPid: process.pid,
          handoffPath,
          attemptId,
          workerName,
          expectedRevision,
          expectedFingerprint: sourceFingerprint,
          feedbackFingerprint: feedback.fingerprint,
          privateRoot,
          candidateRoot,
          testRoot,
          status: 'reserved',
          createdAt: new Date().toISOString(),
        };
        paths = await reserveAttempt(repositoryRoot, record);
        await assertCurrent(task, current);
        assertAuthority(
          await currentAuthority(options, adapters),
          options,
          task,
        );
        const privateCopy = await prepareSource({
          issueNumber,
          attemptId,
          workspace: sourceWorkspace,
          privateRoot,
          expectedBranch: task.branch,
          expectedRevision,
          expectedFingerprint: sourceFingerprint,
          authorizedChangePaths,
          protectedPaths,
          signal: lifecycleSignal,
          runCommand,
          inspectWorkspace,
        });
        disk = measureInertAttemptDisk({
          privateRoot,
          candidateRoot,
          testRoot,
          attemptId,
          existing: ['privateRoot'],
          runCommand,
        });
        record = await updateAttempt(paths, record, 'source-prepared', {
          baselineDigest: privateCopy.contentDigest,
        });
        await assertCurrent(task, current);
        assertAuthority(
          await currentAuthority(options, adapters),
          options,
          task,
        );
        const uid = Number(
          runCommand(['id', '-u'], { timeout: 5000, maxBuffer: 128 }).trim(),
        );
        const gid = Number(
          runCommand(['id', '-g'], { timeout: 5000, maxBuffer: 128 }).trim(),
        );
        const mount = buildPrivatePodmanArgs(
          {
            issueNumber,
            attemptNumber,
            privateCopy,
            privateRoot,
            expectedRevision,
            expectedFingerprint: sourceFingerprint,
            expectedDigest: privateCopy.contentDigest,
            trustedProtectedRoot,
            image: trustedPeonWorkerImage,
            uid,
            gid,
            command: ['python3', '-I', '-c', inertCode, mode, editPath],
            protectedPaths,
            hermesProfile: 'narrow-coding',
            hermesConfigSource,
            writablePaths,
            minimalGuidanceSource,
          },
          { runCommand },
        );
        const args = buildInertPrivateArgs(mount, mode, editPath);
        if ((await inspectContainer(workerName)) !== 'absent')
          throw new Error('Exact inert worker container was substituted.');
        record = await updateAttempt(paths, record, 'worker-running');
        const watchDisk = (existing) =>
          setInterval(() => {
            try {
              disk = measureInertAttemptDisk({
                privateRoot,
                candidateRoot,
                testRoot,
                attemptId,
                existing,
                runCommand,
              });
            } catch (error) {
              diskError = error;
              budgetAbort.abort();
            }
          }, 750);
        const workerMonitor = watchDisk(['privateRoot']);
        let worker;
        try {
          adapters.onWorkerStart?.();
          worker = await launchWorker(args, {
            name: workerName,
            signal: lifecycleSignal,
            timeoutMs: maxInertRuntimeMs,
          });
        } finally {
          clearInterval(workerMonitor);
        }
        const stopped = await confirmTermination(workerName);
        if (
          !stopped?.confirmed ||
          !['absent', 'stopped'].includes(stopped.state)
        )
          throw new Error('Inert worker termination is uncertain.');
        record = await updateAttempt(paths, record, 'worker-stopped', {
          workerExitCode: worker.exitCode,
        });
        if (diskError) throw diskError;
        if (worker.cancelled || worker.timedOut || signal?.aborted) {
          if (worker.error)
            throw new Error('Inert launcher exit is unconfirmed.');
          const status = worker.timedOut ? 'timeout' : 'cancelled';
          record = await updateAttempt(paths, record, status);
          return { status, attemptId, attribution: 'inert-simulation', disk };
        }
        if (
          worker.error ||
          worker.signal ||
          !Number.isSafeInteger(worker.exitCode)
        )
          throw new Error('Inert worker exit is inconclusive.');
        await assertCurrent(task, current);
        assertAuthority(
          await currentAuthority(options, adapters),
          options,
          task,
        );
        const copyOptions = {
          issueNumber,
          attemptNumber,
          privateCopy,
          privateRoot,
          candidateRoot,
          trustedProtectedRoot,
          testRoot,
          expectedRevision,
          expectedFingerprint: sourceFingerprint,
          expectedBaselineDigest: privateCopy.contentDigest,
          authorizedChangePaths,
          protectedPaths,
          uid,
          gid,
          cacheRoot,
          checkNames,
          workerCompletion: Promise.resolve(),
          signal: lifecycleSignal,
        };
        const candidate = await collect(copyOptions, {
          runCommand,
          confirmTermination,
        });
        if (
          candidate?.attemptId !== attemptId ||
          candidate?.sourceRevision !== expectedRevision ||
          candidate?.sourceFingerprint !== sourceFingerprint ||
          candidate?.baselineDigest !== privateCopy.contentDigest ||
          !digestPattern.test(candidate.contentDigest ?? '') ||
          !Array.isArray(candidate.changes)
        )
          throw new Error('Collected candidate identity changed.');
        candidateDigest = candidate.contentDigest;
        disk = measureInertAttemptDisk({
          privateRoot,
          candidateRoot,
          testRoot,
          attemptId,
          existing: ['privateRoot', 'candidateRoot'],
          runCommand,
        });
        record = await updateAttempt(paths, record, 'candidate-collected', {
          candidateDigest,
        });
        let testMonitor;
        let checks;
        try {
          checks = await runChecks(copyOptions, candidate, {
            runCommand,
            confirmTermination,
            onPhase: (_phase, detail = {}) => {
              disk = measureInertAttemptDisk({
                privateRoot,
                candidateRoot,
                testRoot,
                attemptId,
                existing: ['privateRoot', 'candidateRoot', 'testRoot'],
                runCommand,
              });
              if (
                detail.cacheSize !== undefined &&
                (disk.usedBytes + detail.cacheSize > maxAttemptBytes ||
                  disk.freeBytes - detail.cacheSize < minimumFreeBytes)
              )
                throw new Error(
                  'Attempt-local cache copy exceeds disk admission budget.',
                );
              testMonitor ??= watchDisk([
                'privateRoot',
                'candidateRoot',
                'testRoot',
              ]);
            },
          });
        } finally {
          if (testMonitor) clearInterval(testMonitor);
        }
        if (diskError) throw diskError;
        if (
          checks?.attemptId !== attemptId ||
          checks.candidateDigest !== candidate.contentDigest ||
          checks.integrity !== 'verified' ||
          ![
            'tests-passed',
            'tests-failed',
            'dependencies-unavailable',
            'inconclusive',
          ].includes(checks.status)
        )
          throw new Error(
            'Repository test evidence is not bound to the candidate.',
          );
        disk = measureInertAttemptDisk({
          privateRoot,
          candidateRoot,
          testRoot,
          attemptId,
          existing: ['privateRoot', 'candidateRoot', 'testRoot'],
          runCommand,
        });
        await assertCurrent(task, current);
        assertAuthority(
          await currentAuthority(options, adapters),
          options,
          task,
        );
        const status =
          worker.exitCode !== 0
            ? 'worker-failed'
            : candidate.changes.length === 0
              ? 'unchanged'
              : checks.status;
        record = await updateAttempt(paths, record, status, {
          candidateDigest,
          usedBytes: disk.usedBytes,
        });
        return {
          status,
          attemptId,
          attribution: 'inert-simulation',
          candidateDigest,
          repositoryTests: checks.status,
          usage: { modelTokens: 0, toolCalls: 0, source: 'inert-no-model' },
          disk,
        };
      },
    );
    await recordInertCorrectionResult({
      handoffPath,
      issueNumber,
      expectedFingerprint: feedback.fingerprint,
      inspectWorktree,
      result: {
        schema: 'stellar.inert-correction-result/v1',
        issueNumber,
        attemptId,
        attribution: 'inert-simulation',
        status: result.status,
        candidateDigest: result.candidateDigest ?? 'none',
        repositoryTests: result.repositoryTests ?? 'not-run',
        usedBytes: result.disk?.usedBytes ?? 0,
        modelTokens: 0,
        toolCalls: 0,
      },
    });
    await releaseAttempt(paths, record);
    return result;
  } catch (error) {
    if (paths && record) {
      record = await updateAttempt(paths, record, 'quarantined', {
        candidateDigest,
        failure: String(error.message).slice(0, 300),
      });
    }
    throw error;
  }
}

/** Manual recovery confirms exact termination and retains all artifacts for inspection. */
export async function recoverInertPrivateCorrection({
  repositoryRoot,
  attemptId,
  confirmTermination = stopAndConfirmContainer,
  confirmSupervisorStopped,
}) {
  if (
    !attemptPattern.test(attemptId ?? '') ||
    typeof confirmSupervisorStopped !== 'function'
  )
    throw new Error('Exact inert attempt identity is required.');
  const paths = statePaths(repositoryRoot);
  const active = await readJson(paths.active);
  const [, issueText, attemptText] = attemptPattern.exec(attemptId);
  if (
    active.attemptId !== attemptId ||
    active.schema !== 'stellar.inert-private-attempt/v1' ||
    active.issueNumber !== Number(issueText) ||
    active.workerName !== `stellar-peon-worker-${issueText}-${attemptText}`
  )
    throw new Error('Active inert attempt differs from recovery request.');
  let record;
  try {
    record = await readJson(path.join(paths.root, `${attemptId}.json`));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    record = active;
  }
  if (
    record.issueNumber !== active.issueNumber ||
    record.sessionId !== active.sessionId ||
    record.ownerPid !== active.ownerPid ||
    record.handoffPath !== active.handoffPath ||
    record.workerName !== active.workerName ||
    record.attemptId !== active.attemptId
  )
    throw new Error('Inert attempt journal identity changed.');
  if (!(await confirmSupervisorStopped(record.ownerPid)))
    throw new Error('Recovery requires confirmed supervisor termination.');
  for (const name of [
    record.workerName,
    `stellar-peon-verify-${issueText}-${attemptText}`,
  ]) {
    const stopped = await confirmTermination(name);
    if (!stopped?.confirmed || !['absent', 'stopped'].includes(stopped.state))
      throw new Error(
        'Recovery requires confirmed exact container termination.',
      );
  }
  let recorded = false;
  try {
    const handoff = await readHandoff(record.handoffPath);
    recorded =
      handoff.inertCorrectionResults?.some(
        (item) =>
          item.attemptId === attemptId &&
          item.status === record.status &&
          item.candidateDigest === (record.candidateDigest ?? 'none'),
      ) ?? false;
  } catch {
    // Missing or unreadable handoff leaves the attempt quarantined.
  }
  const recovered = await updateAttempt(
    paths,
    record,
    recorded ? 'recovered-complete' : 'recovered-quarantined',
  );
  await releaseAttempt(paths, recovered);
  return {
    attemptId,
    status: recovered.status,
    artifactsRetained: true,
    handoffLockRequiresInspection: true,
  };
}
