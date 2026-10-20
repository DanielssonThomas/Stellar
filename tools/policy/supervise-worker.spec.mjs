import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  formatCapabilityBlockerComment,
  readHandoff,
  superviseWorker,
} from './supervise-worker.mjs';

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
