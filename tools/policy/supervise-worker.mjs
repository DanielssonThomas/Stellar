import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';

export const defaultLimits = Object.freeze({
  maxAttemptsPerWorker: 2,
  maxRuntimeMsPerWorker: 10 * 60 * 1000,
  maxToolCallsPerWorker: 64,
  maxModelTokensPerWorker: 32_000,
  maxRepeatedFailures: 2,
  maxNoProgressAttempts: 2,
});

const hardLimits = Object.freeze({
  maxAttemptsPerWorker: 3,
  maxRuntimeMsPerWorker: 15 * 60 * 1000,
  maxToolCallsPerWorker: 128,
  maxModelTokensPerWorker: 64_000,
  maxRepeatedFailures: 3,
  maxNoProgressAttempts: 3,
});
export const cancellationGraceMs = 5_000;
export const usageReadinessTimeoutMs = 10_000;

class BudgetLimitError extends Error {
  constructor(resource) {
    super(`${resource} budget exhausted`);
    this.name = 'BudgetLimitError';
    this.resource = resource;
  }
}

function normalizeLimits(requested = {}) {
  const limits = { ...defaultLimits, ...requested };
  for (const [key, maximum] of Object.entries(hardLimits)) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1)
      throw new Error(`${key} must be a positive safe integer.`);
    if (limits[key] > maximum)
      throw new Error(`${key} cannot exceed the hard limit of ${maximum}.`);
  }
  return limits;
}

function stableFingerprint(value) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  return createHash('sha256')
    .update(serialized ?? 'undefined')
    .digest('hex');
}

function issueContext(task) {
  if (!Number.isSafeInteger(task?.issueNumber) || task.issueNumber < 1)
    throw new Error('A positive issueNumber is required.');
  if (!task.targetBranch?.trim())
    throw new Error('An authorized targetBranch is required.');
  if (
    !new RegExp(`^issue/${task.issueNumber}-[a-z0-9-]+$`).test(
      task.branch ?? '',
    )
  )
    throw new Error('The issue branch must match the supplied issue number.');
  if (!isAbsolute(task.worktreePath ?? ''))
    throw new Error('An absolute issue worktreePath is required.');
  if (!/^(?:owner|worker):[a-z0-9._-]+$/.test(task.owner ?? ''))
    throw new Error('The current issue owner label is required.');
  return {
    issueNumber: task.issueNumber,
    owner: task.owner,
    targetBranch: task.targetBranch,
    branch: task.branch,
    worktreePath: task.worktreePath,
  };
}

function validateResume(handoff, task, confirmPreviousWorkerStopped) {
  if (handoff.schemaVersion !== 1)
    throw new Error('Unsupported handoff schema version.');
  for (const key of ['issueNumber', 'targetBranch', 'branch', 'worktreePath']) {
    if (handoff.task?.[key] !== task[key])
      throw new Error(
        `Resume handoff ${key} does not match the current issue assignment.`,
      );
  }
  if (handoff.status !== 'handoff-pending' && handoff.task.owner !== task.owner)
    throw new Error(
      'Resume handoff owner does not match the current issue assignment.',
    );
  if (!['paused', 'handoff-pending'].includes(handoff.status))
    throw new Error(`Handoff status '${handoff.status}' is not resumable.`);
  if (handoff.safeToResume === false && confirmPreviousWorkerStopped !== true)
    throw new Error(
      'The previous worker may still be running. Confirm it is stopped before resuming or transferring the worktree.',
    );
}

async function persistHandoff(path, handoff) {
  if (!path) return;
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(handoff, null, 2)}\n`, {
    flag: 'wx',
  });
  await rename(temporary, path);
}

export async function readHandoff(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function createWorkerBudget(limits, previous = {}) {
  let toolCalls = previous.toolCalls ?? 0;
  let modelTokens = previous.modelTokens ?? 0;
  let requestRecords = [];
  let exceededResource = null;
  let reservedTokens = 0;

  function ensureAvailable(resource, used, maximum, reserved = 0) {
    if (used + reserved >= maximum) {
      exceededResource = resource;
      throw new BudgetLimitError(resource);
    }
  }

  return {
    get snapshot() {
      return { toolCalls, modelTokens, exceededResource, requestRecords };
    },
    async runTool(name, operation) {
      if (
        typeof name !== 'string' ||
        !name.trim() ||
        typeof operation !== 'function'
      )
        throw new Error('runTool requires a name and operation.');
      ensureAvailable('tool-calls', toolCalls, limits.maxToolCallsPerWorker);
      toolCalls += 1;
      return operation();
    },
    observeUsage(usage) {
      if (
        !Number.isSafeInteger(usage?.toolCalls) ||
        usage.toolCalls < toolCalls ||
        !Number.isSafeInteger(usage?.modelTokens) ||
        usage.modelTokens < modelTokens
      )
        throw new Error(
          'Trusted live usage counters must be monotonic safe integers.',
        );
      if (usage.requestRecords !== undefined) {
        if (
          !Array.isArray(usage.requestRecords) ||
          usage.requestRecords.length > 32 ||
          usage.requestRecords.some(
            (record) =>
              !Number.isSafeInteger(record?.request) ||
              record.request < 1 ||
              ![
                'pending',
                'denied-exhausted',
                'denied-budget',
                'tokenization-failed',
                'forwarded',
                'upstream-failed',
                'cancelled',
              ].includes(record?.decision) ||
              (record.promptTokens !== null &&
                !Number.isSafeInteger(record.promptTokens)) ||
              !Number.isSafeInteger(record.remainingTokens) ||
              (record.completionTokens !== null &&
                !Number.isSafeInteger(record.completionTokens)) ||
              !Number.isSafeInteger(record.chargedOutputTokens) ||
              !Number.isSafeInteger(record.emittedToolCalls) ||
              !Number.isSafeInteger(record.toolSchemaContentTokens) ||
              !Number.isSafeInteger(record.toolOutputMessages) ||
              !record.messageContentTokensByRole ||
              typeof record.messageContentTokensByRole !== 'object' ||
              Object.values(record.messageContentTokensByRole).some(
                (tokens) => !Number.isSafeInteger(tokens),
              ) ||
              Object.keys(record.messageContentTokensByRole).some(
                (role) =>
                  ![
                    'system',
                    'developer',
                    'user',
                    'assistant',
                    'tool',
                    'other',
                  ].includes(role),
              ) ||
              Object.keys(record).some(
                (key) =>
                  ![
                    'request',
                    'decision',
                    'promptTokens',
                    'remainingTokens',
                    'completionTokens',
                    'chargedOutputTokens',
                    'emittedToolCalls',
                    'messageContentTokensByRole',
                    'toolSchemaContentTokens',
                    'toolOutputMessages',
                  ].includes(key),
              ),
          )
        )
          throw new Error(
            'Trusted live request records must contain bounded numeric-only metadata.',
          );
        requestRecords = usage.requestRecords.map((record) => ({ ...record }));
      }
      toolCalls = usage.toolCalls;
      modelTokens = usage.modelTokens;
      const exhausted = usage.exceededResource;
      if (exhausted && !['tool-calls', 'model-tokens'].includes(exhausted))
        throw new Error(
          'Trusted live usage reported an unknown exhausted resource.',
        );
      if (exhausted) exceededResource = exhausted;
      if (toolCalls > limits.maxToolCallsPerWorker)
        exceededResource = 'tool-calls';
      if (modelTokens > limits.maxModelTokensPerWorker)
        exceededResource = 'model-tokens';
      return { toolCalls, modelTokens, exceededResource, requestRecords };
    },
    async runModel({ promptTokens = 0, maxOutputTokens, invoke }) {
      if (
        !Number.isSafeInteger(promptTokens) ||
        promptTokens < 0 ||
        !Number.isSafeInteger(maxOutputTokens) ||
        maxOutputTokens < 1 ||
        typeof invoke !== 'function'
      )
        throw new Error(
          'runModel requires promptTokens, maxOutputTokens, and invoke.',
        );
      const remaining =
        limits.maxModelTokensPerWorker - modelTokens - reservedTokens;
      if (promptTokens >= remaining) {
        exceededResource = 'model-tokens';
        throw new BudgetLimitError('model-tokens');
      }
      const outputLimit = Math.min(maxOutputTokens, remaining - promptTokens);
      const reservation = promptTokens + outputLimit;
      reservedTokens += reservation;
      try {
        const response = await invoke({ maxOutputTokens: outputLimit });
        const usage = response?.usage ?? {};
        const reported = Number.isSafeInteger(usage.totalTokens)
          ? usage.totalTokens
          : Number.isSafeInteger(usage.promptTokens) &&
              Number.isSafeInteger(usage.completionTokens)
            ? usage.promptTokens + usage.completionTokens
            : reservation;
        if (reported > reservation) {
          modelTokens += reservation;
          exceededResource = 'model-tokens';
          throw new BudgetLimitError('model-tokens');
        }
        modelTokens += reported;
        return response;
      } finally {
        reservedTokens -= reservation;
      }
    },
  };
}

function failureDetails(error) {
  const code =
    typeof error?.code === 'string'
      ? error.code
      : (error?.name ?? 'WorkerError');
  const message = redactEvidence(
    String(error?.message ?? error ?? 'Worker failed'),
  )
    .trim()
    .replace(/\s+/g, ' ');
  const details = {
    code,
    message: message.slice(0, 2_000),
    fingerprint: stableFingerprint(`${code}:${message}`),
  };
  if (error?.diagnostic) {
    const { category, phase, elapsedMs } = error.diagnostic;
    const categories = [
      'sidecar-not-started',
      'readiness-timeout',
      'podman-execution-failure',
      'usage-endpoint-unavailable',
      'http-failure',
      'malformed-response',
      'invalid-usage',
      'sidecar-terminated',
      'cleanup-inconclusive',
      'unknown',
    ];
    details.diagnostic = {
      category: categories.includes(category) ? category : 'unknown',
      phase: ['startup', 'running', 'cancellation', 'cleanup'].includes(phase)
        ? phase
        : 'unknown',
      elapsedMs:
        Number.isSafeInteger(elapsedMs) && elapsedMs >= 0
          ? Math.min(elapsedMs, 900_000)
          : null,
    };
  }
  return details;
}

function redactEvidence(value) {
  return value
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gi,
      '[REDACTED]',
    )
    .replace(/\b(Bearer)\s+[^\s,;]+/gi, '$1 [REDACTED]')
    .replace(
      /\b((?:api[-_ ]?key|token|secret|password)\s*[:=]\s*)[^\s,;]+/gi,
      '$1[REDACTED]',
    )
    .replace(/:\/\/[^\s/@:]+:[^\s/@]+@/g, '://[REDACTED]@');
}

function worktreeState(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof value.fingerprint !== 'string'
  )
    throw new Error('inspectWorktree must return a string fingerprint.');
  return {
    fingerprint: stableFingerprint(value.fingerprint),
    changes: Array.isArray(value.changes)
      ? value.changes.map(String).slice(0, 100)
      : [],
  };
}

async function runBounded(worker, context, timeoutMs, externalSignal) {
  const controller = new AbortController();
  let timer;
  let abortListener;
  const completion = Promise.resolve()
    .then(() => worker.run({ ...context, signal: controller.signal }))
    .then(
      (result) => ({ type: 'result', result }),
      (error) => ({ type: 'error', error }),
    );
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ type: 'timeout' }), timeoutMs);
  });
  const interruption = externalSignal
    ? new Promise((resolve) => {
        abortListener = () => resolve({ type: 'interrupted' });
        externalSignal.addEventListener('abort', abortListener, { once: true });
        if (externalSignal.aborted) abortListener();
      })
    : null;
  if (typeof worker.waitForUsageReady === 'function') {
    const readinessStartedAt = Date.now();
    let readyTimer;
    const readiness = Promise.race([
      Promise.resolve()
        .then(() =>
          worker.waitForUsageReady({
            task: context.task,
            attemptNumber: context.attemptNumber,
          }),
        )
        .then(
          () => ({ type: 'ready' }),
          (error) => ({ type: 'usage-readiness-failed', error }),
        ),
      new Promise((resolve) => {
        readyTimer = setTimeout(
          () => resolve({ type: 'usage-readiness-timeout' }),
          Math.min(usageReadinessTimeoutMs, timeoutMs),
        );
      }),
    ]);
    const startupRaces = [completion, timeout, readiness];
    if (interruption) startupRaces.push(interruption);
    const startup = await Promise.race(startupRaces);
    clearTimeout(readyTimer);
    if (startup.type === 'ready') {
      // Usage polling starts only after the trusted adapter has proven the
      // exact attempt's metering endpoint is readable.
    } else {
      clearTimeout(timer);
      if (abortListener)
        externalSignal.removeEventListener('abort', abortListener);
      const outcome =
        startup.type === 'usage-readiness-timeout'
          ? {
              type: 'usage-accounting-failed',
              error: {
                code: 'UsageReadinessTimeout',
                message:
                  'Trusted usage endpoint was not ready before the deadline.',
                diagnostic: {
                  category: 'readiness-timeout',
                  phase: 'startup',
                  elapsedMs: Date.now() - readinessStartedAt,
                },
              },
            }
          : startup.type === 'usage-readiness-failed'
            ? {
                type: 'usage-accounting-failed',
                error: {
                  code: 'UsageReadinessFailed',
                  message: 'Trusted usage endpoint failed during startup.',
                  diagnostic: {
                    ...(startup.error?.diagnostic ?? {}),
                    phase: 'startup',
                    elapsedMs: Date.now() - readinessStartedAt,
                  },
                },
              }
            : startup;
      if (
        ['timeout', 'interrupted', 'usage-accounting-failed', 'error'].includes(
          outcome.type,
        )
      ) {
        controller.abort(outcome.type);
        const cancellationStartedAt = Date.now();
        const workerStopped = await confirmWorkerStopped(worker, outcome.type);
        return {
          ...outcome,
          workerStopped,
          ...(!workerStopped
            ? {
                cancellationDiagnostic: {
                  category: 'cleanup-inconclusive',
                  phase: 'cancellation',
                  elapsedMs: Date.now() - cancellationStartedAt,
                },
              }
            : {}),
        };
      }
      return outcome;
    }
  }
  const races = [completion, timeout];
  let usageTimer;
  let polling = false;
  const resourceLimit = new Promise((resolve) => {
    if (typeof worker.usage !== 'function') return;
    usageTimer = setInterval(async () => {
      if (polling) return;
      polling = true;
      let usage;
      try {
        usage = await worker.usage({
          task: context.task,
          attemptNumber: context.attemptNumber,
        });
      } catch (error) {
        resolve({
          type: 'usage-accounting-failed',
          error: {
            code: 'UsageAccountingFailure',
            message: 'Trusted live usage polling failed.',
            diagnostic: {
              ...(error?.diagnostic ?? {
                category: 'unknown',
                phase: 'running',
              }),
            },
          },
        });
        return;
      }
      try {
        const snapshot = context.budget.observeUsage(usage);
        if (snapshot.exceededResource)
          resolve({
            type: 'budget-exceeded',
            resource: snapshot.exceededResource,
          });
      } catch {
        resolve({
          type: 'usage-accounting-failed',
          error: {
            code: 'InvalidUsageSnapshot',
            message: 'Trusted live usage snapshot failed validation.',
            diagnostic: {
              category: 'invalid-usage',
              phase: 'running',
            },
          },
        });
      } finally {
        polling = false;
      }
    }, 100);
    usageTimer.unref?.();
  });
  if (typeof worker.usage === 'function') races.push(resourceLimit);
  if (externalSignal) {
    races.push(interruption);
  }
  const outcome = await Promise.race(races);
  clearTimeout(timer);
  clearInterval(usageTimer);
  if (abortListener) externalSignal.removeEventListener('abort', abortListener);
  if (
    [
      'timeout',
      'interrupted',
      'budget-exceeded',
      'usage-accounting-failed',
      'error',
    ].includes(outcome.type)
  ) {
    controller.abort(outcome.type);
    const cancellationStartedAt = Date.now();
    const workerStopped = await confirmWorkerStopped(worker, outcome.type);
    return {
      ...outcome,
      workerStopped,
      ...(!workerStopped
        ? {
            cancellationDiagnostic: {
              category: 'cleanup-inconclusive',
              phase: 'cancellation',
              elapsedMs: Date.now() - cancellationStartedAt,
            },
          }
        : {}),
    };
  }
  return outcome;
}

async function confirmWorkerStopped(worker, reason) {
  if (typeof worker.cancel !== 'function') return false;
  let timer;
  try {
    const confirmed = await Promise.race([
      Promise.resolve().then(() => worker.cancel(reason)),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), cancellationGraceMs);
      }),
    ]);
    return confirmed === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function getPrimaryStopReason(outcome) {
  switch (outcome.type) {
    case 'timeout':
      return 'runtime-budget-exhausted';
    case 'interrupted':
      return 'interrupted';
    case 'budget-exceeded':
      return ['model-tokens', 'tool-calls'].includes(outcome.resource)
        ? `${outcome.resource}-budget-exhausted`
        : 'unknown';
    case 'usage-accounting-failed':
      return 'usage-accounting-failed';
    default:
      return 'unknown';
  }
}

function appendFailure(handoff, workerId, failure) {
  handoff.failures.push({ workerId, at: new Date().toISOString(), ...failure });
}

function escalationRequest(handoff, reason) {
  return {
    issueNumber: handoff.task.issueNumber,
    category: 'agent-capability',
    status: 'blocked',
    requested: true,
    fromWorker: 'mira',
    to: 'codex',
    reason,
    branch: handoff.task.branch,
    worktreePath: handoff.task.worktreePath,
    attemptedSolutions: handoff.attemptedSolutions,
    verificationResults: handoff.verificationResults,
    failureEvidence: handoff.failures,
    recorded: false,
    invoked: false,
  };
}

export function formatCapabilityBlockerComment(request) {
  const attempts = request.failureEvidence.length
    ? request.failureEvidence
        .map((item) => `- ${item.workerId}: ${item.code}: ${item.message}`)
        .join('\n')
    : '- Worker capability limit reached.';
  const verification = request.verificationResults.length
    ? request.verificationResults
        .map(
          (item) =>
            `- ${item.name ?? 'check'}: ${item.passed ? 'passed' : 'failed'}${item.summary ? ` — ${redactEvidence(String(item.summary))}` : ''}`,
        )
        .join('\n')
    : '- No successful verification results.';
  return [
    '## Blocker',
    'The assigned worker tiers could not complete the issue within their bounded limits.',
    '',
    '## Evidence',
    `- Category: ${request.category}`,
    `- Branch: ${request.branch}`,
    `- Worktree: ${request.worktreePath}`,
    `- Codex escalation requested: yes (not invoked)`,
    '',
    '## Verification',
    verification,
    '',
    '## Attempts',
    attempts,
    '',
    '## Progress',
    request.attemptedSolutions.length
      ? request.attemptedSolutions.map((item) => `- ${item}`).join('\n')
      : '- No durable changes were reported.',
  ].join('\n');
}

export async function superviseWorker({
  task: rawTask,
  workers,
  inspectWorktree,
  verify,
  authorizeHandoff,
  handoffPath,
  resume,
  limits: requestedLimits,
  signal,
  recordEscalationRequest,
  confirmPreviousWorkerStopped = false,
  clock = () => Date.now(),
}) {
  const task = issueContext(rawTask);
  const limits = normalizeLimits(requestedLimits);
  if (typeof inspectWorktree !== 'function' || typeof verify !== 'function')
    throw new Error(
      'Trusted inspectWorktree and verify callbacks are required.',
    );
  for (const id of ['peon', 'mira']) {
    if (workers?.[id]?.id !== id || typeof workers[id].run !== 'function')
      throw new Error(`A ${id} worker adapter is required.`);
  }

  const handoff = resume ?? {
    schemaVersion: 1,
    task,
    status: 'running',
    safeToResume: true,
    currentWorkerId: 'peon',
    createdAt: new Date(clock()).toISOString(),
    updatedAt: new Date(clock()).toISOString(),
    attempts: [],
    attemptedSolutions: [],
    verificationResults: [],
    failures: [],
    transfers: [],
    workerUsage: {},
  };
  if (resume) validateResume(handoff, task, confirmPreviousWorkerStopped);
  if (confirmPreviousWorkerStopped) handoff.safeToResume = true;
  handoff.safeToResume ??= true;
  handoff.attempts ??= [];
  handoff.attemptedSolutions ??= [];
  handoff.verificationResults ??= [];
  handoff.failures ??= [];
  handoff.transfers ??= [];
  handoff.workerUsage ??= {};
  for (const id of ['peon', 'mira']) {
    handoff.workerUsage[id] ??= {
      attempts: 0,
      runtimeMs: 0,
      toolCalls: 0,
      modelTokens: 0,
    };
  }

  const startedAt = clock();
  const runtimeBeforeResume = ['peon', 'mira'].reduce(
    (sum, id) => sum + handoff.workerUsage[id].runtimeMs,
    0,
  );
  async function save(status) {
    handoff.status = status;
    handoff.updatedAt = new Date(clock()).toISOString();
    await persistHandoff(handoffPath, handoff);
  }

  let workerId = handoff.nextWorkerId ?? handoff.currentWorkerId ?? 'peon';
  if (workerId === 'mira' && handoff.status === 'handoff-pending') {
    if (typeof authorizeHandoff !== 'function')
      return { status: 'handoff-pending', handoff };
    const authorization = await authorizeHandoff({
      issueNumber: task.issueNumber,
      fromWorker: 'peon',
      toWorker: 'mira',
      expectedOwner: 'worker:mira',
      targetBranch: task.targetBranch,
      branch: task.branch,
      worktreePath: task.worktreePath,
      reason: handoff.lastStopReason,
    });
    if (
      authorization?.owner !== 'worker:mira' ||
      authorization.targetBranch !== task.targetBranch ||
      authorization.branch !== task.branch ||
      authorization.worktreePath !== task.worktreePath
    )
      return { status: 'handoff-pending', handoff };
    handoff.transfers.push({
      from: task.owner,
      to: authorization.owner,
      reason: handoff.lastStopReason,
      targetBranch: authorization.targetBranch,
      branch: authorization.branch,
      worktreePath: authorization.worktreePath,
      at: new Date(clock()).toISOString(),
    });
    handoff.task.owner = authorization.owner;
    handoff.nextWorkerId = null;
    handoff.currentWorkerId = 'mira';
  }
  while (workerId) {
    const worker = workers[workerId];
    handoff.currentWorkerId = workerId;
    const state = handoff.workerUsage[workerId];
    let previousFailure = state.lastFailureFingerprint ?? null;
    let repeatedFailures = state.repeatedFailures ?? 0;
    let noProgressAttempts = state.noProgressAttempts ?? 0;
    let stopReason = null;

    while (state.attempts < limits.maxAttemptsPerWorker) {
      if (signal?.aborted) {
        await save('paused');
        return { status: 'paused', handoff };
      }
      const elapsed = Math.max(0, clock() - startedAt);
      const totalElapsed = runtimeBeforeResume + elapsed;
      const workerRemaining = limits.maxRuntimeMsPerWorker - state.runtimeMs;
      const taskRemaining = 2 * limits.maxRuntimeMsPerWorker - totalElapsed;
      const timeoutMs = Math.min(workerRemaining, taskRemaining);
      if (timeoutMs <= 0) {
        stopReason = 'runtime-budget-exhausted';
        break;
      }

      const before = worktreeState(await inspectWorktree(task));
      const attemptNumber = state.attempts + 1;
      const attemptStarted = clock();
      const budget = createWorkerBudget(limits, state);
      let outcome = await runBounded(
        worker,
        {
          task,
          workerId,
          attemptNumber,
          limits,
          budget,
          onUsage: (usage) => budget.observeUsage(usage),
          handoff,
        },
        timeoutMs,
        signal,
      );
      if (outcome.type === 'result' && typeof worker.usage === 'function') {
        try {
          if (!outcome.result?.usage)
            throw new Error(
              'Live worker returned no final trusted usage snapshot.',
            );
          budget.observeUsage(outcome.result.usage);
        } catch {
          outcome = {
            type: 'usage-accounting-failed',
            workerStopped: await confirmWorkerStopped(
              worker,
              'usage-accounting-failed',
            ),
          };
        }
      }
      const durationMs = Math.max(0, clock() - attemptStarted);
      state.attempts += 1;
      state.runtimeMs += Math.min(durationMs, timeoutMs);
      state.toolCalls = budget.snapshot.toolCalls;
      state.modelTokens = budget.snapshot.modelTokens;
      const attempt = {
        workerId,
        attemptNumber,
        startedAt: new Date(attemptStarted).toISOString(),
        durationMs,
        progressed: false,
        changedFiles: before.changes,
        toolCalls: budget.snapshot.toolCalls,
        modelTokens: budget.snapshot.modelTokens,
        requestRecords: budget.snapshot.requestRecords,
      };
      if (
        [
          'timeout',
          'interrupted',
          'budget-exceeded',
          'usage-accounting-failed',
          'error',
        ].includes(outcome.type) &&
        !outcome.workerStopped
      ) {
        const primaryStopReason = getPrimaryStopReason(outcome);
        const failure = failureDetails({
          code: 'CancellationUnconfirmed',
          message:
            'Worker stop was not confirmed; do not resume or hand off this worktree until the process is stopped.',
          ...(outcome.cancellationDiagnostic
            ? { diagnostic: outcome.cancellationDiagnostic }
            : {}),
        });
        attempt.primaryStopReason = primaryStopReason;
        attempt.status = 'cancellation-unconfirmed';
        attempt.failure = failure;
        handoff.attempts.push(attempt);
        appendFailure(handoff, workerId, failure);
        handoff.currentWorkerId = workerId;
        handoff.lastStopReason = primaryStopReason;
        handoff.safeToResume = false;
        await save('paused');
        return { status: 'paused', handoff, safeToResume: false };
      }
      const after = worktreeState(await inspectWorktree(task));
      const progressed = before.fingerprint !== after.fingerprint;
      if (progressed) {
        noProgressAttempts = 0;
        if (after.changes.length)
          handoff.attemptedSolutions.push(
            `${workerId} changed: ${after.changes.join(', ')}`,
          );
      } else {
        noProgressAttempts += 1;
      }

      attempt.progressed = progressed;
      attempt.changedFiles = after.changes;
      let result = null;
      let failure = null;

      if (outcome.type === 'timeout') {
        failure = failureDetails({
          code: 'RuntimeLimit',
          message: `Worker exceeded ${timeoutMs} ms.`,
        });
        stopReason = 'runtime-budget-exhausted';
      } else if (outcome.type === 'interrupted') {
        failure = failureDetails({
          code: 'Interrupted',
          message: 'Execution was interrupted and paused.',
        });
        attempt.status = 'interrupted';
        handoff.attempts.push(attempt);
        state.noProgressAttempts = noProgressAttempts;
        state.lastFailureFingerprint = failure.fingerprint;
        state.repeatedFailures =
          previousFailure === failure.fingerprint && !progressed
            ? repeatedFailures + 1
            : 1;
        appendFailure(handoff, workerId, failure);
        handoff.currentWorkerId = workerId;
        await save('paused');
        return { status: 'paused', handoff };
      } else if (
        outcome.type === 'budget-exceeded' ||
        outcome.type === 'usage-accounting-failed'
      ) {
        failure = failureDetails({
          code:
            outcome.type === 'budget-exceeded'
              ? 'ResourceLimit'
              : (outcome.error?.code ?? 'UsageAccountingFailure'),
          message:
            outcome.type === 'budget-exceeded'
              ? `Trusted live ${outcome.resource} budget was exhausted.`
              : 'Trusted live usage accounting failed; worker stopped fail-closed.',
          ...(outcome.error?.diagnostic
            ? { diagnostic: outcome.error.diagnostic }
            : {}),
        });
        stopReason =
          outcome.type === 'budget-exceeded'
            ? `${outcome.resource}-budget-exhausted`
            : 'usage-accounting-failed';
      } else if (outcome.type === 'error') {
        failure = failureDetails(outcome.error);
      } else {
        result = outcome.result ?? {};
        attempt.status = result.status ?? 'failed';
        if (result.attemptedSolution)
          handoff.attemptedSolutions.push(
            redactEvidence(String(result.attemptedSolution)).slice(0, 2_000),
          );
        if (Array.isArray(result.failureEvidence))
          for (const item of result.failureEvidence)
            appendFailure(handoff, workerId, failureDetails(item));
        if (result.status === 'capability-limit') {
          failure = failureDetails(
            result.failure ?? {
              code: 'CapabilityLimit',
              message: result.reason ?? 'Worker opted out due to capability.',
            },
          );
          stopReason = 'capability-limit';
        } else if (result.status === 'completed') {
          const verifyRemaining = Math.min(
            limits.maxRuntimeMsPerWorker - state.runtimeMs,
            2 * limits.maxRuntimeMsPerWorker -
              runtimeBeforeResume -
              (clock() - startedAt),
          );
          if (verifyRemaining <= 0) {
            failure = failureDetails({
              code: 'RuntimeLimit',
              message: 'Verification exceeded the remaining runtime budget.',
            });
            stopReason = 'runtime-budget-exhausted';
          } else {
            const verifyStarted = clock();
            const verificationOutcome = await runBounded(
              {
                run: ({ signal: verifySignal }) =>
                  verify({ task, workerId, result, signal: verifySignal }),
                cancel: (reason) => verify.cancel?.(reason),
              },
              {},
              verifyRemaining,
              signal,
            );
            const verifyDuration = Math.max(0, clock() - verifyStarted);
            state.runtimeMs += Math.min(verifyDuration, verifyRemaining);
            attempt.durationMs += verifyDuration;
            if (
              ['timeout', 'interrupted', 'error'].includes(
                verificationOutcome.type,
              ) &&
              !verificationOutcome.workerStopped
            ) {
              failure = failureDetails({
                code: 'CancellationUnconfirmed',
                message:
                  'Verification stop was not confirmed; do not resume or hand off this worktree until its process is stopped.',
              });
              attempt.status = 'verification-cancellation-unconfirmed';
              attempt.failure = failure;
              handoff.attempts.push(attempt);
              appendFailure(handoff, workerId, failure);
              handoff.currentWorkerId = workerId;
              handoff.safeToResume = false;
              await save('paused');
              return { status: 'paused', handoff, safeToResume: false };
            }
            if (verificationOutcome.type === 'interrupted') {
              failure = failureDetails({
                code: 'Interrupted',
                message: 'Verification was interrupted and paused.',
              });
              attempt.status = 'verification-interrupted';
              handoff.attempts.push(attempt);
              appendFailure(handoff, workerId, failure);
              state.lastFailureFingerprint = failure.fingerprint;
              state.repeatedFailures = 1;
              state.noProgressAttempts = noProgressAttempts;
              handoff.currentWorkerId = workerId;
              await save('paused');
              return { status: 'paused', handoff };
            }
            if (verificationOutcome.type === 'timeout') {
              failure = failureDetails({
                code: 'RuntimeLimit',
                message: `Verification exceeded ${verifyRemaining} ms.`,
              });
              stopReason = 'runtime-budget-exhausted';
            } else if (verificationOutcome.type === 'error') {
              failure = failureDetails(verificationOutcome.error);
            } else {
              const verification = verificationOutcome.result;
              const checks = Array.isArray(verification)
                ? verification
                : [verification];
              handoff.verificationResults.push(...checks);
              attempt.verificationResults = checks;
              if (
                checks.length > 0 &&
                checks.every((check) => check?.passed === true)
              ) {
                handoff.attempts.push(attempt);
                handoff.currentWorkerId = null;
                await save('complete');
                return { status: 'complete', handoff };
              }
              failure = failureDetails({
                code: 'VerificationFailed',
                message: 'One or more trusted verification checks failed.',
              });
            }
          }
        } else if (result.failure) {
          failure = failureDetails(result.failure);
        }
      }

      if (failure) {
        const sameFailure =
          previousFailure === failure.fingerprint && !progressed;
        repeatedFailures = sameFailure ? repeatedFailures + 1 : 1;
        previousFailure = failure.fingerprint;
        attempt.failure = failure;
        appendFailure(handoff, workerId, failure);
      } else {
        previousFailure = null;
        repeatedFailures = 0;
      }
      state.lastFailureFingerprint = previousFailure;
      state.repeatedFailures = repeatedFailures;
      state.noProgressAttempts = noProgressAttempts;
      if (budget.snapshot.exceededResource) {
        stopReason = `${budget.snapshot.exceededResource}-budget-exhausted`;
      }
      attempt.status ??= failure ? 'failed' : 'continued';
      handoff.attempts.push(attempt);
      await save('running');

      if (stopReason) break;
      if (repeatedFailures >= limits.maxRepeatedFailures) {
        stopReason = 'repeated-unchanged-failure';
        break;
      }
      if (noProgressAttempts >= limits.maxNoProgressAttempts) {
        stopReason = 'no-meaningful-progress';
        break;
      }
    }

    if (!stopReason && state.attempts >= limits.maxAttemptsPerWorker)
      stopReason = 'attempt-budget-exhausted';
    handoff.lastStopReason = stopReason ?? 'worker-stopped';
    if (workerId === 'peon') {
      if (typeof authorizeHandoff !== 'function') {
        handoff.nextWorkerId = 'mira';
        await save('handoff-pending');
        return { status: 'handoff-pending', handoff };
      }
      const authorization = await authorizeHandoff({
        issueNumber: task.issueNumber,
        fromWorker: 'peon',
        toWorker: 'mira',
        expectedOwner: 'worker:mira',
        targetBranch: task.targetBranch,
        branch: task.branch,
        worktreePath: task.worktreePath,
        reason: handoff.lastStopReason,
      });
      const validAuthorization =
        authorization?.owner === 'worker:mira' &&
        authorization.targetBranch === task.targetBranch &&
        authorization.branch === task.branch &&
        authorization.worktreePath === task.worktreePath;
      if (!validAuthorization) {
        handoff.nextWorkerId = 'mira';
        await save('handoff-pending');
        return { status: 'handoff-pending', handoff };
      }
      handoff.transfers.push({
        from: task.owner,
        to: authorization.owner,
        reason: handoff.lastStopReason,
        targetBranch: authorization.targetBranch,
        branch: authorization.branch,
        worktreePath: authorization.worktreePath,
        at: new Date(clock()).toISOString(),
      });
      handoff.task.owner = authorization.owner;
      workerId = 'mira';
      handoff.currentWorkerId = workerId;
      handoff.nextWorkerId = null;
      await save('running');
      continue;
    }

    handoff.currentWorkerId = null;
    handoff.escalation = escalationRequest(handoff, handoff.lastStopReason);
    await save('blocked');
    if (typeof recordEscalationRequest === 'function') {
      try {
        const recorded = await recordEscalationRequest({
          owner: handoff.task.owner,
          expectedStatus: 'in-progress',
          nextStatus: 'blocked',
          request: handoff.escalation,
          comment: formatCapabilityBlockerComment(handoff.escalation),
        });
        if (recorded !== true)
          throw new Error(
            'Issue update did not confirm the escalation request.',
          );
        handoff.escalation.recorded = true;
      } catch (error) {
        handoff.escalation.recorded = false;
        handoff.escalation.recordError = failureDetails(error).message;
      }
      await save('blocked');
    }
    return {
      status: 'blocked',
      handoff,
      escalationRequest: handoff.escalation,
    };
  }

  await save('paused');
  return { status: 'paused', handoff };
}
