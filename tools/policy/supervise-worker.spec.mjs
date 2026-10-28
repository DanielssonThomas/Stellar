import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  appendMentorFeedback,
  correctionFeedbackFromHandoff,
  formatCapabilityBlockerComment,
  readHandoff,
  superviseWorker,
} from './supervise-worker.mjs';
import { createPeonWorkerAdapter } from './run-restricted-worker.mjs';

const temporaryRoot = await mkdtemp(join(tmpdir(), 'stellar-supervisor-'));
after(async () => rm(temporaryRoot, { recursive: true, force: true }));

const task = {
  issueNumber: 222,
  owner: 'owner:codex',
  targetBranch: 'develop',
  branch: 'issue/222-bounded-worker-supervision',
  worktreePath: join(temporaryRoot, 'issue-222'),
};

function worker(id, run, cancel) {
  return { id, run, cancel: cancel ?? (async () => true) };
}

function authorizeMira(request) {
  assert.equal(request.issueNumber, task.issueNumber);
  assert.equal(request.fromWorker, 'peon');
  assert.equal(request.toWorker, 'mira');
  return {
    owner: 'worker:mira',
    targetBranch: request.targetBranch,
    branch: request.branch,
    worktreePath: request.worktreePath,
  };
}

function base(overrides = {}) {
  const verify = async () => [{ name: 'checks', passed: true }];
  verify.cancel = async () => true;
  return {
    task,
    workers: {
      peon: worker('peon', async () => ({ status: 'completed' })),
      mira: worker('mira', async () => ({ status: 'completed' })),
    },
    inspectWorktree: async () => ({ fingerprint: 'initial', changes: [] }),
    verify,
    ...overrides,
  };
}

describe('bounded worker supervision', () => {
  it('records bounded, revision-bound feedback for a stopped format failure', async () => {
    const handoffPath = join(temporaryRoot, 'mentor-format-handoff.json');
    let fingerprint = 'unchanged';
    const inspectWorktree = async () => ({
      fingerprint,
      changes: [],
    });
    const result = await superviseWorker(
      base({
        handoffPath,
        limits: { maxAttemptsPerWorker: 1 },
        inspectWorktree,
        workers: {
          peon: worker('peon', async () => ({
            status: 'failed',
            failure: {
              code: 'FormatError',
              message: 'The required report field is missing.',
            },
          })),
          mira: worker('mira', async () => {
            throw new Error('Mira must not run');
          }),
        },
      }),
    );
    const before = await readHandoff(handoffPath);
    const feedback = {
      handoffPath,
      issueNumber: task.issueNumber,
      attemptNumber: 1,
      expectedUpdatedAt: before.updatedAt,
      expectedFingerprint: result.handoff.attempts[0].afterFingerprint,
      level: 'diagnostic',
      evidence: { kind: 'failure' },
      lessonProposal: 'Check the required report fields before submitting.',
      inspectWorktree,
    };
    const event = await appendMentorFeedback(feedback);
    assert.match(event.diagnostic, /required report field/);
    assert.equal(event.implementationAuthor, null);
    assert.equal(event.lessonProposal.state, 'draft');
    assert.equal(event.lessonProposal.scope, 'unclassified');
    assert.equal((await readHandoff(handoffPath)).mentorFeedback.length, 1);
    await assert.rejects(appendMentorFeedback(feedback), /stale/);
    const fresh = await readHandoff(handoffPath);
    await assert.rejects(
      appendMentorFeedback({
        ...feedback,
        expectedUpdatedAt: fresh.updatedAt,
        expectedFingerprint: 'wrong',
      }),
      /does not match/,
    );
    await assert.rejects(
      appendMentorFeedback({
        ...feedback,
        expectedUpdatedAt: fresh.updatedAt,
        lessonProposal: 'x'.repeat(1_001),
      }),
      /short plain text/,
    );
    await assert.rejects(
      appendMentorFeedback({
        ...feedback,
        expectedUpdatedAt: fresh.updatedAt,
        lessonProposal: 'unsafe\u0000content',
      }),
      /short plain text/,
    );
    const conceptual = await appendMentorFeedback({
      ...feedback,
      expectedUpdatedAt: fresh.updatedAt,
      level: 'conceptual',
      guidance: 'Check the report schema against the required fields.',
      lessonProposal: undefined,
    });
    assert.equal(conceptual.level, 'conceptual');
    const afterConceptual = await readHandoff(handoffPath);
    assert.equal(
      correctionFeedbackFromHandoff(afterConceptual, task.issueNumber).guidance,
      'Check the report schema against the required fields.',
    );
    assert.throws(
      () => correctionFeedbackFromHandoff(afterConceptual, 999),
      /unsafe/,
    );
    fingerprint = 'codex-change';
    const assisted = await appendMentorFeedback({
      ...feedback,
      expectedUpdatedAt: afterConceptual.updatedAt,
      level: 'codex-fix',
      guidance: 'Codex authored the correction after Peon attempts.',
      lessonProposal: undefined,
    });
    assert.equal(assisted.implementationAuthor, 'codex');
    assert.notEqual(assisted.resultFingerprint, assisted.fingerprint);
    const afterAssistance = await readHandoff(handoffPath);
    assert.throws(
      () => correctionFeedbackFromHandoff(afterAssistance, task.issueNumber),
      /No verified/,
    );
  });
  it('persists sanitized tool outcomes under the four-request supervisor ceiling', async () => {
    const pre = {
      phase: 'pre',
      callId: 'a'.repeat(24),
      toolName: 'terminal',
      argumentBytes: 18,
      argumentCount: 1,
    };
    const post = {
      ...pre,
      phase: 'post',
      status: 'error',
      elapsedMs: 31,
      outputBytes: 20,
      exitCode: 1,
    };
    let observedLimits;
    const result = await superviseWorker(
      base({
        task: {
          ...task,
          issueNumber: 50,
          owner: 'worker:peon',
          branch: 'issue/50-avatar-shape',
          hermesProfile: 'narrow-evidence',
          hermesWorkflow: 'edit-first-4',
          maxForwardedRequests: 4,
        },
        limits: { maxAttemptsPerWorker: 1, maxModelTokensPerWorker: 52_000 },
        workers: {
          peon: worker('peon', async ({ limits, budget }) => {
            observedLimits = limits;
            budget.observeUsage({
              toolCalls: 1,
              modelTokens: 100,
              forwardedRequests: 1,
              toolEvents: [pre, post],
            });
            return {
              status: 'failed',
              usage: {
                toolCalls: 1,
                modelTokens: 100,
                forwardedRequests: 1,
                toolEvents: [pre, post],
              },
              failure: { code: 'OfflineFailure', message: 'offline fixture' },
            };
          }),
          mira: worker('mira', async () => {
            throw new Error('Mira must not run');
          }),
        },
      }),
    );
    assert.equal(observedLimits.maxModelTokensPerWorker, 52_000);
    assert.equal(observedLimits.maxToolCallsPerWorker, 64);
    assert.equal(observedLimits.maxRuntimeMsPerWorker, 600_000);
    assert.deepEqual(result.handoff.attempts[0].toolEvents, [pre, post]);
    await assert.rejects(
      superviseWorker(
        base({
          task: {
            ...task,
            issueNumber: 50,
            owner: 'worker:peon',
            branch: 'issue/50-avatar-shape',
            hermesProfile: 'narrow-evidence',
            hermesWorkflow: 'edit-first-4',
            maxForwardedRequests: 4,
          },
          limits: { maxAttemptsPerWorker: 1, maxModelTokensPerWorker: 32_000 },
        }),
      ),
      /exactly 52,000/,
    );
  });
  it('delivers validated narrow bounded metadata to the Peon adapter and verification', async () => {
    const manifest = {
      schema: 'stellar.peon-task-context/v1',
      issue: { number: task.issueNumber },
      authorization: {
        maxForwardedRequests: 2,
        limits: { modelTokens: 32_000 },
        allowedChangePaths: ['libs/ui/atoms/src/lib/skeleton-atom.ts'],
      },
    };
    let adapterInput;
    let verifiedTask;
    const peon = createPeonWorkerAdapter({
      image: 'test-image',
      hermesProfile: 'narrow-coding',
      maxForwardedRequests: 2,
      preparedContext: { manifest, serialized: JSON.stringify(manifest) },
      commandForTask: () => ['offline-test'],
      runAttempt: async (input) => {
        adapterInput = input;
        return {
          exitCode: 0,
          usage: { toolCalls: 0, modelTokens: 0, forwardedRequests: 0 },
        };
      },
    });
    const result = await superviseWorker(
      base({
        task: {
          ...task,
          hermesProfile: 'narrow-coding',
          hermesWorkflow: 'bounded-coding',
          maxForwardedRequests: 2,
          untrustedIssueMetadata: 'must not cross projection',
        },
        workers: {
          peon,
          mira: worker('mira', async () => ({ status: 'completed' })),
        },
        verify: async ({ task: verified }) => {
          verifiedTask = verified;
          return [{ name: 'authorized-source-changes', passed: true }];
        },
      }),
    );

    assert.equal(result.status, 'complete');
    assert.equal(adapterInput.hermesProfile, 'narrow-coding');
    assert.equal(adapterInput.maxForwardedRequests, 2);
    assert.equal(verifiedTask.hermesWorkflow, 'bounded-coding');
    assert.equal(verifiedTask.maxForwardedRequests, 2);
    assert.equal(Object.hasOwn(verifiedTask, 'untrustedIssueMetadata'), false);
    assert.equal(result.handoff.task.hermesProfile, 'narrow-coding');
    assert.equal(result.handoff.task.hermesWorkflow, 'bounded-coding');
  });

  it('rejects unsupported or inconsistent Hermes task metadata before dispatch', async () => {
    let dispatched = false;
    const args = base({
      workers: {
        peon: worker('peon', async () => {
          dispatched = true;
          return { status: 'completed' };
        }),
        mira: worker('mira', async () => ({ status: 'completed' })),
      },
    });
    for (const invalid of [
      { hermesProfile: 'untrusted-profile' },
      { hermesProfile: null },
      { hermesWorkflow: 'unbounded' },
      {
        hermesProfile: 'focus',
        hermesWorkflow: 'bounded-coding',
        maxForwardedRequests: 2,
      },
      { hermesWorkflow: 'bounded-coding', maxForwardedRequests: null },
      { hermesWorkflow: 'standard', maxForwardedRequests: 2 },
    ]) {
      await assert.rejects(
        superviseWorker({ ...args, task: { ...task, ...invalid } }),
      );
    }
    assert.equal(dispatched, false);
  });

  it('retains adapter rejection when a supported but mismatched profile is delivered', async () => {
    let attemptStarted = false;
    const adapter = createPeonWorkerAdapter({
      image: 'test-image',
      hermesProfile: 'narrow-coding',
      runAttempt: async () => {
        attemptStarted = true;
        return { exitCode: 0, usage: { toolCalls: 0, modelTokens: 0 } };
      },
    });
    await assert.rejects(
      adapter.run({
        task: { ...task, hermesProfile: 'focus' },
        attemptNumber: 1,
        limits: { maxRuntimeMsPerWorker: 60_000 },
        budget: { snapshot: { toolCalls: 0, modelTokens: 0 } },
      }),
      /Worker adapter profile differs from the validated issue/,
    );
    assert.equal(attemptStarted, false);
  });

  it('keeps omitted metadata compatible with the standard focus workflow', async () => {
    let delivered;
    const result = await superviseWorker(
      base({
        workers: {
          peon: worker('peon', async ({ task: selected }) => {
            delivered = selected;
            return { status: 'completed' };
          }),
          mira: worker('mira', async () => ({ status: 'completed' })),
        },
      }),
    );
    assert.equal(result.status, 'complete');
    assert.equal(delivered.hermesProfile, 'focus');
    assert.equal(delivered.hermesWorkflow, 'standard');
    assert.equal(delivered.maxForwardedRequests, null);
  });

  it('completes only after trusted verification passes', async () => {
    let verified = 0;
    const result = await superviseWorker(
      base({
        verify: async () => {
          verified += 1;
          return [{ name: 'unit', passed: true }];
        },
      }),
    );

    assert.equal(result.status, 'complete');
    assert.equal(verified, 1);
    assert.equal(result.handoff.attempts[0].workerId, 'peon');
    assert.equal(result.handoff.verificationResults[0].passed, true);
  });

  it('routes repeated unchanged failures to Mira with the same issue worktree', async () => {
    let miraCalls = 0;
    let transfers = 0;
    const result = await superviseWorker(
      base({
        workers: {
          peon: worker('peon', async () => ({
            status: 'failed',
            failure: { code: 'LintFailed', message: 'same lint error' },
            attemptedSolution: 'Ran the affected lint target.',
          })),
          mira: worker('mira', async () => {
            miraCalls += 1;
            return {
              status: 'completed',
              attemptedSolution: 'Corrected the lint issue.',
            };
          }),
        },
        authorizeHandoff: async (request) => {
          transfers += 1;
          return authorizeMira(request);
        },
      }),
    );

    assert.equal(result.status, 'complete');
    assert.equal(miraCalls, 1);
    assert.equal(transfers, 1);
    assert.equal(result.handoff.lastStopReason, 'repeated-unchanged-failure');
    assert.equal(result.handoff.task.targetBranch, 'develop');
    assert.equal(result.handoff.task.branch, task.branch);
    assert.equal(result.handoff.task.worktreePath, task.worktreePath);
    assert.equal(result.handoff.task.owner, 'worker:mira');
    assert.equal(result.handoff.transfers[0].from, 'owner:codex');
    assert.equal(result.handoff.failures[0].message, 'same lint error');
  });

  it('routes an attempt-budget exhaustion after meaningful progress', async () => {
    let snapshot = 0;
    let peonCalls = 0;
    const result = await superviseWorker(
      base({
        limits: { maxAttemptsPerWorker: 2 },
        workers: {
          peon: worker('peon', async () => {
            peonCalls += 1;
            snapshot += 1;
            return {
              status: 'continue',
              attemptedSolution: `Applied step ${peonCalls}.`,
            };
          }),
          mira: worker('mira', async () => ({ status: 'completed' })),
        },
        inspectWorktree: async () => ({
          fingerprint: String(snapshot),
          changes: [`step-${snapshot}`],
        }),
        authorizeHandoff: authorizeMira,
      }),
    );

    assert.equal(result.status, 'complete');
    assert.equal(peonCalls, 2);
    assert.equal(result.handoff.lastStopReason, 'attempt-budget-exhausted');
    assert.equal(result.handoff.attemptedSolutions.length, 4);
  });

  it('enforces tool and model token budgets before dispatching more work', async () => {
    let toolRuns = 0;
    let modelOutputLimit;
    const result = await superviseWorker(
      base({
        limits: {
          maxToolCallsPerWorker: 1,
          maxModelTokensPerWorker: 10,
        },
        workers: {
          peon: worker('peon', async ({ budget }) => {
            await budget.runTool('lint', async () => {
              toolRuns += 1;
            });
            await budget.runModel({
              promptTokens: 5,
              maxOutputTokens: 20,
              invoke: async ({ maxOutputTokens }) => {
                modelOutputLimit = maxOutputTokens;
                return { usage: { totalTokens: 10 } };
              },
            });
            await budget.runModel({
              promptTokens: 1,
              maxOutputTokens: 1,
              invoke: async () => {
                modelOutputLimit = -1;
                return {};
              },
            });
            return { status: 'continue' };
          }),
          mira: worker('mira', async () => ({ status: 'completed' })),
        },
        authorizeHandoff: authorizeMira,
      }),
    );

    assert.equal(result.status, 'complete');
    assert.equal(toolRuns, 1);
    assert.equal(modelOutputLimit, 5);
    assert.equal(result.handoff.attempts[0].toolCalls, 1);
    assert.equal(result.handoff.attempts[0].modelTokens, 10);
    assert.equal(
      result.handoff.lastStopReason,
      'model-tokens-budget-exhausted',
    );
  });

  it('rejects tool operations once the per-worker tool budget is exhausted', async () => {
    let toolRuns = 0;
    const result = await superviseWorker(
      base({
        limits: { maxToolCallsPerWorker: 1 },
        workers: {
          peon: worker('peon', async ({ budget }) => {
            await budget.runTool('lint', async () => {
              toolRuns += 1;
            });
            await budget.runTool('test', async () => {
              toolRuns += 1;
            });
            return { status: 'continue' };
          }),
          mira: worker('mira', async () => ({ status: 'completed' })),
        },
        authorizeHandoff: authorizeMira,
      }),
    );

    assert.equal(result.status, 'complete');
    assert.equal(toolRuns, 1);
    assert.equal(result.handoff.lastStopReason, 'tool-calls-budget-exhausted');
  });

  it('stops the worker when trusted live counters report budget exhaustion', async () => {
    let cancellations = 0;
    const result = await superviseWorker(
      base({
        limits: { maxToolCallsPerWorker: 1 },
        workers: {
          peon: {
            ...worker(
              'peon',
              ({ signal }) =>
                new Promise((resolve) =>
                  signal.addEventListener(
                    'abort',
                    () => resolve({ status: 'failed' }),
                    { once: true },
                  ),
                ),
              () => {
                cancellations += 1;
                return true;
              },
            ),
            usage: async () => ({
              toolCalls: 2,
              modelTokens: 4,
              exceededResource: 'tool-calls',
            }),
          },
          mira: worker('mira', async () => ({ status: 'completed' })),
        },
        authorizeHandoff: authorizeMira,
      }),
    );

    assert.equal(result.status, 'complete');
    assert.equal(cancellations, 1);
    const stopped = result.handoff.attempts.find(
      (attempt) => attempt.workerId === 'peon',
    );
    assert.equal(stopped.toolCalls, 2);
    assert.equal(stopped.failure.code, 'ResourceLimit');
  });

  it('preserves request-limit exhaustion and unsafe cancellation state', async () => {
    const requestRecord = {
      request: 3,
      decision: 'denied-request-limit',
      promptTokens: null,
      remainingTokens: 20_000,
      completionTokens: null,
      chargedOutputTokens: 0,
      emittedToolCalls: 0,
      messageContentTokensByRole: {},
      toolSchemaContentTokens: 0,
      toolOutputMessages: 0,
    };
    const result = await superviseWorker(
      base({
        limits: { maxRuntimeMsPerWorker: 2_000 },
        workers: {
          peon: {
            ...worker(
              'peon',
              () => new Promise(() => undefined),
              async () => false,
            ),
            usage: async () => ({
              toolCalls: 0,
              modelTokens: 4_000,
              forwardedRequests: 2,
              exceededResource: 'model-requests',
              requestRecords: [requestRecord],
            }),
          },
          mira: worker('mira', async () => ({ status: 'completed' })),
        },
      }),
    );
    assert.equal(result.status, 'paused');
    assert.equal(result.safeToResume, false);
    assert.equal(
      result.handoff.lastStopReason,
      'model-request-limit-exhausted',
    );
    assert.equal(
      result.handoff.attempts[0].primaryStopReason,
      'model-request-limit-exhausted',
    );
    assert.equal(result.handoff.attempts[0].forwardedRequests, 2);
    assert.equal(
      result.handoff.attempts[0].requestRecords[0].decision,
      'denied-request-limit',
    );
  });

  it('does not verify or complete when the final snapshot shows a denied third request', async () => {
    const snapshot = {
      toolCalls: 2,
      modelTokens: 8_000,
      forwardedRequests: 2,
      exceededResource: 'model-requests',
      requestRecords: [
        {
          request: 3,
          decision: 'denied-request-limit',
          promptTokens: null,
          remainingTokens: 24_000,
          completionTokens: null,
          chargedOutputTokens: 0,
          emittedToolCalls: 0,
          messageContentTokensByRole: {},
          toolSchemaContentTokens: 0,
          toolOutputMessages: 0,
        },
      ],
    };
    let verificationCalls = 0;
    const result = await superviseWorker(
      base({
        task: {
          ...task,
          hermesProfile: 'narrow-coding',
          hermesWorkflow: 'bounded-coding',
          maxForwardedRequests: 2,
        },
        workers: {
          peon: {
            id: 'peon',
            run: async () => ({ status: 'completed', usage: snapshot }),
            usage: async () => snapshot,
            cancel: async () => true,
          },
          mira: worker('mira', async () => ({ status: 'completed' })),
        },
        verify: async () => {
          verificationCalls += 1;
          return [{ name: 'should-not-run', passed: true }];
        },
      }),
    );
    assert.equal(verificationCalls, 0);
    assert.notEqual(result.status, 'complete');
    assert.equal(
      result.handoff.lastStopReason,
      'model-request-limit-exhausted',
    );
  });

  it('records final live counters even when the worker exits before the first poll', async () => {
    const result = await superviseWorker(
      base({
        workers: {
          peon: {
            ...worker('peon', async () => ({
              status: 'completed',
              usage: { toolCalls: 1, modelTokens: 7, exceededResource: null },
            })),
            usage: async () => ({ toolCalls: 0, modelTokens: 0 }),
          },
          mira: worker('mira', async () => ({ status: 'completed' })),
        },
      }),
    );

    assert.equal(result.status, 'complete');
    assert.equal(result.handoff.attempts[0].toolCalls, 1);
    assert.equal(result.handoff.attempts[0].modelTokens, 7);
  });

  it('preserves validated numeric-only per-request metering records in the handoff', async () => {
    const requestRecord = {
      request: 2,
      decision: 'denied-budget',
      promptTokens: 16_993,
      remainingTokens: 16_993,
      completionTokens: null,
      chargedOutputTokens: 0,
      emittedToolCalls: 0,
      messageContentTokensByRole: { system: 100, user: 15 },
      toolSchemaContentTokens: 250,
      toolOutputMessages: 0,
    };
    const result = await superviseWorker(
      base({
        workers: {
          peon: {
            ...worker('peon', async () => ({
              status: 'failed',
              usage: {
                toolCalls: 5,
                modelTokens: 15_007,
                exceededResource: 'model-tokens',
                requestRecords: [requestRecord],
              },
            })),
            usage: async () => ({
              toolCalls: 5,
              modelTokens: 15_007,
              exceededResource: 'model-tokens',
              requestRecords: [requestRecord],
            }),
          },
          mira: worker('mira', async () => ({ status: 'completed' })),
        },
      }),
    );

    assert.deepEqual(result.handoff.attempts[0].requestRecords, [
      requestRecord,
    ]);
  });

  it('fails closed when a live request record contains prompt content', async () => {
    let cancelled = false;
    const result = await superviseWorker(
      base({
        workers: {
          peon: {
            ...worker(
              'peon',
              ({ signal }) =>
                new Promise((resolve) =>
                  signal.addEventListener(
                    'abort',
                    () => resolve({ status: 'failed' }),
                    {
                      once: true,
                    },
                  ),
                ),
            ),
            usage: async () => ({
              toolCalls: 0,
              modelTokens: 0,
              requestRecords: [
                {
                  request: 1,
                  decision: 'denied-budget',
                  promptTokens: 2,
                  remainingTokens: 2,
                  completionTokens: null,
                  chargedOutputTokens: 0,
                  emittedToolCalls: 0,
                  prompt: 'must never be persisted',
                },
              ],
            }),
            cancel: async () => {
              cancelled = true;
              return true;
            },
          },
          mira: worker('mira', async () => ({ status: 'completed' })),
        },
      }),
    );

    assert.equal(cancelled, true);
    assert.equal(
      result.handoff.attempts[0].failure.code,
      'InvalidUsageSnapshot',
    );
    assert.equal(
      result.handoff.attempts[0].failure.diagnostic.category,
      'invalid-usage',
    );
    assert.doesNotMatch(
      JSON.stringify(result.handoff),
      /must never be persisted/,
    );
  });

  it('stops and escalates when the trusted live usage channel fails', async () => {
    let cancelled = false;
    const result = await superviseWorker(
      base({
        workers: {
          peon: {
            ...worker(
              'peon',
              ({ signal }) =>
                new Promise((resolve) =>
                  signal.addEventListener(
                    'abort',
                    () => resolve({ status: 'failed' }),
                    { once: true },
                  ),
                ),
              async () => {
                cancelled = true;
                return true;
              },
            ),
            usage: async () => {
              const error = new Error('raw response with sensitive content');
              error.diagnostic = {
                category: 'sidecar-terminated',
                phase: 'running',
                elapsedMs: 71,
              };
              throw error;
            },
          },
          mira: worker('mira', async () => ({ status: 'completed' })),
        },
        authorizeHandoff: authorizeMira,
      }),
    );

    assert.equal(result.status, 'complete');
    assert.equal(cancelled, true);
    const stopped = result.handoff.attempts.find(
      (attempt) => attempt.workerId === 'peon',
    );
    assert.equal(stopped.failure.code, 'UsageAccountingFailure');
    assert.deepEqual(stopped.failure.diagnostic, {
      category: 'sidecar-terminated',
      phase: 'running',
      elapsedMs: 71,
    });
    assert.doesNotMatch(
      JSON.stringify(result.handoff),
      /raw response with sensitive content/,
    );
  });

  it('waits for the exact trusted usage source before polling delayed startup', async () => {
    let sidecarReady = false;
    let inferencePermitted = false;
    let prematurePolls = 0;
    let successfulPolls = 0;
    let resolveReadiness;
    const usageReady = new Promise((resolve) => {
      resolveReadiness = resolve;
    });
    const delayedWorker = {
      ...worker('peon', async () => {
        await new Promise((resolve) => setTimeout(resolve, 180));
        sidecarReady = true;
        resolveReadiness();
        inferencePermitted = true;
        await new Promise((resolve) => setTimeout(resolve, 180));
        return {
          status: 'failed',
          failure: { code: 'NoInference', message: 'startup-only test' },
          usage: { toolCalls: 0, modelTokens: 0 },
        };
      }),
      waitForUsageReady: () => usageReady,
      usage: async () => {
        if (!sidecarReady || !inferencePermitted) {
          prematurePolls += 1;
          const error = new Error('simulated sidecar not ready');
          error.diagnostic = {
            category: 'sidecar-not-started',
            phase: 'startup',
            elapsedMs: 1,
          };
          throw error;
        }
        successfulPolls += 1;
        return { toolCalls: 0, modelTokens: 0 };
      },
    };
    const result = await superviseWorker(
      base({
        workers: {
          peon: delayedWorker,
          mira: worker('mira', async () => ({ status: 'completed' })),
        },
        limits: { maxRuntimeMsPerWorker: 2_000, maxAttemptsPerWorker: 1 },
      }),
    );

    assert.equal(prematurePolls, 0);
    assert.ok(successfulPolls > 0);
    assert.equal(result.handoff.attempts[0].failure.code, 'NoInference');
  });

  it('records only sanitized startup accounting category and timing', async () => {
    let cancelled = false;
    const delayedWorker = {
      ...worker(
        'peon',
        ({ signal }) =>
          new Promise((resolve) =>
            signal.addEventListener(
              'abort',
              () => resolve({ status: 'failed' }),
              { once: true },
            ),
          ),
        async () => {
          cancelled = true;
          return true;
        },
      ),
      waitForUsageReady: async () => {
        const error = new Error('untrusted raw response must not persist');
        error.diagnostic = {
          category: 'usage-endpoint-unavailable',
          phase: 'startup',
          elapsedMs: 37,
          response: 'do not persist',
        };
        throw error;
      },
      usage: async () =>
        assert.fail('usage must not be polled before readiness'),
    };
    const result = await superviseWorker(
      base({
        workers: {
          peon: delayedWorker,
          mira: worker('mira', async () => ({ status: 'completed' })),
        },
        limits: { maxAttemptsPerWorker: 1 },
      }),
    );

    const attempt = result.handoff.attempts[0];
    assert.equal(cancelled, true);
    assert.equal(attempt.failure.code, 'UsageReadinessFailed');
    assert.equal(
      attempt.failure.diagnostic.category,
      'usage-endpoint-unavailable',
    );
    assert.equal(attempt.failure.diagnostic.phase, 'startup');
    assert.ok(Number.isSafeInteger(attempt.failure.diagnostic.elapsedMs));
    assert.doesNotMatch(
      JSON.stringify(result.handoff),
      /untrusted raw response|do not persist/,
    );
  });

  it('stops a timed out worker and routes within the total runtime ceiling', async () => {
    let cancelled = false;
    let miraCalls = 0;
    const result = await superviseWorker(
      base({
        limits: { maxRuntimeMsPerWorker: 20 },
        workers: {
          peon: worker(
            'peon',
            () =>
              new Promise((resolve) => {
                const pending = setTimeout(
                  () => resolve({ status: 'continue' }),
                  60_000,
                );
                pending.unref();
              }),
            () => {
              cancelled = true;
              return true;
            },
          ),
          mira: worker('mira', async () => {
            miraCalls += 1;
            return { status: 'completed' };
          }),
        },
        authorizeHandoff: authorizeMira,
      }),
    );

    assert.equal(result.status, 'complete');
    assert.equal(cancelled, true);
    assert.equal(miraCalls, 1);
    assert.equal(result.handoff.attempts[0].failure.code, 'RuntimeLimit');
  });

  it('does not hand off a worktree when worker termination is unconfirmed', async () => {
    let miraCalls = 0;
    const result = await superviseWorker(
      base({
        limits: { maxRuntimeMsPerWorker: 20 },
        workers: {
          peon: worker(
            'peon',
            () =>
              new Promise((resolve) => {
                const pending = setTimeout(
                  () => resolve({ status: 'continue' }),
                  60_000,
                );
                pending.unref();
              }),
            async () => false,
          ),
          mira: worker('mira', async () => {
            miraCalls += 1;
            return { status: 'completed' };
          }),
        },
        authorizeHandoff: authorizeMira,
      }),
    );

    assert.equal(result.status, 'paused');
    assert.equal(result.safeToResume, false);
    assert.equal(miraCalls, 0);
    await assert.rejects(
      superviseWorker(base({ resume: result.handoff })),
      /Confirm it is stopped/,
    );
  });

  it('keeps a failed worker unsafe when container cleanup cannot be confirmed', async () => {
    const result = await superviseWorker(
      base({
        workers: {
          peon: worker(
            'peon',
            async () => {
              throw new Error('worker runner cleanup was inconclusive');
            },
            async () => false,
          ),
          mira: worker('mira', async () => ({ status: 'completed' })),
        },
        authorizeHandoff: authorizeMira,
      }),
    );

    assert.equal(result.status, 'paused');
    assert.equal(result.safeToResume, false);
    assert.equal(result.handoff.attempts[0].status, 'cancellation-unconfirmed');
    assert.match(
      result.handoff.attempts[0].failure.message,
      /Worker stop was not confirmed/,
    );
  });

  it('preserves the primary token-budget stop when cancellation is unconfirmed', async () => {
    const result = await superviseWorker(
      base({
        limits: { maxRuntimeMsPerWorker: 2_000 },
        workers: {
          peon: {
            ...worker(
              'peon',
              () => new Promise(() => undefined),
              async () => false,
            ),
            usage: async () => ({
              toolCalls: 0,
              modelTokens: 11,
              exceededResource: 'model-tokens',
            }),
          },
          mira: worker('mira', async () => ({ status: 'completed' })),
        },
      }),
    );

    assert.equal(result.status, 'paused');
    assert.equal(result.safeToResume, false);
    assert.equal(result.handoff.safeToResume, false);
    assert.equal(
      result.handoff.lastStopReason,
      'model-tokens-budget-exhausted',
    );
    assert.equal(
      result.handoff.attempts[0].primaryStopReason,
      'model-tokens-budget-exhausted',
    );
    assert.equal(
      result.handoff.attempts[0].failure.code,
      'CancellationUnconfirmed',
    );
  });

  it('preserves accounting failure separately from unconfirmed cancellation', async () => {
    const result = await superviseWorker(
      base({
        limits: { maxRuntimeMsPerWorker: 2_000 },
        workers: {
          peon: {
            ...worker(
              'peon',
              () => new Promise(() => undefined),
              async () => false,
            ),
            usage: async () => {
              throw Object.assign(new Error('private transport detail'), {
                diagnostic: {
                  category: 'usage-endpoint-unavailable',
                  phase: 'running',
                },
              });
            },
          },
          mira: worker('mira', async () => ({ status: 'completed' })),
        },
      }),
    );

    assert.equal(result.status, 'paused');
    assert.equal(result.safeToResume, false);
    assert.equal(result.handoff.lastStopReason, 'usage-accounting-failed');
    assert.equal(
      result.handoff.attempts[0].primaryStopReason,
      'usage-accounting-failed',
    );
    assert.equal(
      result.handoff.attempts[0].failure.code,
      'CancellationUnconfirmed',
    );
    assert.equal(
      result.handoff.attempts[0].primaryFailure.diagnostic.category,
      'usage-endpoint-unavailable',
    );
    assert.equal(
      result.handoff.attempts[0].primaryFailure.diagnostic.phase,
      'running',
    );
    assert.doesNotMatch(
      JSON.stringify(result.handoff),
      /private transport detail/,
    );
  });

  it('persists bounded timeout, cancellation, and model categories after either cancellation outcome', async () => {
    for (const category of [
      'transport-timeout',
      'poll-cancelled',
      'model-unavailable',
    ]) {
      for (const confirmed of [false, true]) {
        const result = await superviseWorker(
          base({
            limits: { maxAttemptsPerWorker: 1 },
            workers: {
              peon: {
                ...worker(
                  'peon',
                  () => new Promise(() => undefined),
                  async () => confirmed,
                ),
                usage: async () => {
                  const error = new Error('private response must not persist');
                  error.diagnostic = {
                    category,
                    phase:
                      category === 'model-unavailable' ? 'startup' : 'running',
                    elapsedMs: 33,
                  };
                  throw error;
                },
              },
              mira: worker('mira', async () => ({ status: 'completed' })),
            },
          }),
        );
        const attempt = result.handoff.attempts[0];
        const persisted = confirmed ? attempt.failure : attempt.primaryFailure;
        assert.equal(persisted.diagnostic.category, category);
        assert.equal(persisted.diagnostic.elapsedMs, 33);
        assert.doesNotMatch(JSON.stringify(result.handoff), /private response/);
      }
    }
  });

  it('keeps an unclassified primary stop cause explicitly unknown', async () => {
    const result = await superviseWorker(
      base({
        workers: {
          peon: worker(
            'peon',
            async () => {
              throw new Error('unclassified worker failure');
            },
            async () => false,
          ),
          mira: worker('mira', async () => ({ status: 'completed' })),
        },
      }),
    );

    assert.equal(result.status, 'paused');
    assert.equal(result.safeToResume, false);
    assert.equal(result.handoff.lastStopReason, 'unknown');
    assert.equal(result.handoff.attempts[0].primaryStopReason, 'unknown');
    assert.equal(
      result.handoff.attempts[0].failure.code,
      'CancellationUnconfirmed',
    );
  });

  it('keeps verification work unsafe when verification failure cannot be stopped', async () => {
    const verify = Object.assign(
      async () => {
        throw new Error('verification runner failed');
      },
      { cancel: async () => false },
    );
    const result = await superviseWorker(
      base({
        verify,
        workers: {
          peon: worker('peon', async () => ({ status: 'completed' })),
          mira: worker('mira', async () => ({ status: 'completed' })),
        },
      }),
    );

    assert.equal(result.status, 'paused');
    assert.equal(result.safeToResume, false);
    assert.equal(
      result.handoff.attempts[0].status,
      'verification-cancellation-unconfirmed',
    );
  });

  it('bounds verification runtime as part of the worker budget', async () => {
    let verificationCalls = 0;
    const result = await superviseWorker(
      base({
        limits: { maxRuntimeMsPerWorker: 20 },
        workers: {
          peon: worker('peon', async () => ({ status: 'completed' })),
          mira: worker('mira', async () => ({ status: 'completed' })),
        },
        verify: Object.assign(
          async ({ workerId }) => {
            verificationCalls += 1;
            if (workerId === 'peon')
              return new Promise((resolve) => {
                const pending = setTimeout(
                  () => resolve([{ name: 'checks', passed: false }]),
                  60_000,
                );
                pending.unref();
              });
            return [{ name: 'checks', passed: true }];
          },
          { cancel: async () => true },
        ),
        authorizeHandoff: authorizeMira,
      }),
    );

    assert.equal(result.status, 'complete');
    assert.equal(verificationCalls, 2);
    assert.equal(result.handoff.attempts[0].failure.code, 'RuntimeLimit');
  });

  it('persists interruption state and resumes without discarding the worktree', async () => {
    const handoffPath = join(temporaryRoot, 'interrupted', 'handoff.json');
    const controller = new AbortController();
    let started;
    const didStart = new Promise((resolve) => {
      started = resolve;
    });
    let peonCalls = 0;
    let cancelled = false;
    const workers = {
      peon: worker(
        'peon',
        ({ signal }) => {
          peonCalls += 1;
          if (peonCalls > 1) return Promise.resolve({ status: 'completed' });
          started();
          return new Promise((resolve) =>
            signal.addEventListener(
              'abort',
              () => resolve({ status: 'continue' }),
              { once: true },
            ),
          );
        },
        () => {
          cancelled = true;
          return true;
        },
      ),
      mira: worker('mira', async () => ({ status: 'completed' })),
    };
    const args = base({ workers, handoffPath, signal: controller.signal });
    const interrupted = superviseWorker(args);
    await didStart;
    controller.abort();
    const paused = await interrupted;

    assert.equal(paused.status, 'paused');
    assert.equal(cancelled, true);
    assert.equal((await readHandoff(handoffPath)).status, 'paused');
    assert.equal(
      (await readFile(handoffPath, 'utf8')).includes(task.branch),
      true,
    );

    const resumed = await superviseWorker(
      base({ workers, handoffPath, resume: await readHandoff(handoffPath) }),
    );
    assert.equal(resumed.status, 'complete');
    assert.equal(peonCalls, 2);
    assert.equal(resumed.handoff.attempts[0].status, 'interrupted');
  });

  it('returns a blocked Codex request without invoking any Codex worker', async () => {
    let codexCalls = 0;
    let issueRequests = 0;
    const result = await superviseWorker(
      base({
        workers: {
          peon: worker('peon', async () => ({
            status: 'capability-limit',
            reason: 'out of depth',
          })),
          mira: worker('mira', async () => {
            throw Object.assign(
              new Error('token=supersecret cannot resolve type error'),
              { code: 'TypeCheck' },
            );
          }),
          codex: worker('codex', async () => {
            codexCalls += 1;
            return { status: 'completed' };
          }),
        },
        authorizeHandoff: authorizeMira,
        recordEscalationRequest: async (update) => {
          issueRequests += 1;
          assert.equal(update.owner, 'worker:mira');
          assert.equal(update.expectedStatus, 'in-progress');
          assert.equal(update.nextStatus, 'blocked');
          assert.ok(
            update.comment.includes(
              'Codex escalation requested: yes (not invoked)',
            ),
          );
          return true;
        },
      }),
    );

    assert.equal(result.status, 'blocked');
    assert.equal(result.escalationRequest.category, 'agent-capability');
    assert.equal(result.escalationRequest.status, 'blocked');
    assert.equal(result.escalationRequest.requested, true);
    assert.equal(result.escalationRequest.invoked, false);
    assert.equal(result.escalationRequest.recorded, true);
    assert.equal(issueRequests, 1);
    assert.equal(codexCalls, 0);
    const comment = formatCapabilityBlockerComment(result.escalationRequest);
    for (const heading of [
      '## Blocker',
      '## Evidence',
      '## Attempts',
      '## Progress',
    ])
      assert.ok(comment.includes(heading));
    assert.ok(
      comment.includes('Codex escalation requested: yes (not invoked)'),
    );
    assert.ok(!comment.includes('supersecret'));
    assert.ok(comment.includes('token=[REDACTED]'));
  });

  it('keeps the issue in a resumable handoff when reassignment is not authorized', async () => {
    const result = await superviseWorker(
      base({
        workers: {
          peon: worker('peon', async () => ({ status: 'capability-limit' })),
          mira: worker('mira', async () => {
            throw new Error('must not run before transfer');
          }),
        },
        authorizeHandoff: async (request) => ({
          ...authorizeMira(request),
          targetBranch: 'main',
        }),
      }),
    );

    assert.equal(result.status, 'handoff-pending');
    assert.equal(result.handoff.nextWorkerId, 'mira');
    assert.equal(result.handoff.task.owner, 'owner:codex');
    assert.equal(result.handoff.currentWorkerId, 'peon');
  });

  it('resumes a pending tier handoff only after the current issue assignment is authorized', async () => {
    const first = await superviseWorker(
      base({
        workers: {
          peon: worker('peon', async () => ({ status: 'capability-limit' })),
          mira: worker('mira', async () => ({ status: 'completed' })),
        },
        authorizeHandoff: async () => false,
      }),
    );
    let miraCalls = 0;
    const resumed = await superviseWorker(
      base({
        workers: {
          peon: worker('peon', async () => {
            throw new Error('Peon must not repeat after handoff.');
          }),
          mira: worker('mira', async () => {
            miraCalls += 1;
            return { status: 'completed' };
          }),
        },
        resume: first.handoff,
        authorizeHandoff: authorizeMira,
      }),
    );

    assert.equal(first.status, 'handoff-pending');
    assert.equal(resumed.status, 'complete');
    assert.equal(miraCalls, 1);
    assert.equal(resumed.handoff.task.owner, 'worker:mira');
    assert.equal(resumed.handoff.transfers.length, 1);
  });
});
