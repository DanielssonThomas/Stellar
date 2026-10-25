import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, it } from 'node:test';
import { supervisePostJob } from './post-job-supervisor.mjs';

const root = await mkdtemp(join(tmpdir(), 'stellar-post-job-'));
after(() => rm(root, { recursive: true, force: true }));
const handoffPath = join(root, 'handoff.json');
const auditPath = join(root, 'audit.jsonl');
const headSha = 'a'.repeat(40);
await writeFile(
  handoffPath,
  JSON.stringify({ headSha, task: { issueNumber: 42 }, attempts: [] }),
);

const launch = () => {
  const child = new EventEmitter();
  child.pid = 123;
  queueMicrotask(() => child.emit('close', 0, null));
  return child;
};

it('inspects the launched worker PID after exit, then triggers cleanup once', async () => {
  let calls = 0;
  const result = await supervisePostJob({
    root,
    issueNumber: 42,
    handoffPath,
    auditPath,
    sessionId: 'one',
    command: ['node', 'worker.mjs'],
    launch,
    inspectStop: async ({ workerPid }) => {
      assert.equal(workerPid, 123);
      return {
        workerExited: true,
        attemptContainersStopped: true,
        verificationStopped: true,
      };
    },
    cleanup: async (args) => {
      calls += 1;
      assert.equal(args.remoteAuthorized, false);
      assert.equal(args.releaseSessionId, 'one');
      return { eligible: true, reasons: [] };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.decision.eligible, true);
});

it('preserves a failed or cancelled worker when stop cannot be confirmed', async () => {
  let calls = 0;
  const result = await supervisePostJob({
    root,
    issueNumber: 42,
    handoffPath,
    auditPath,
    sessionId: 'one',
    command: ['node', 'worker.mjs'],
    launch,
    inspectStop: async () => ({
      workerExited: false,
      attemptContainersStopped: true,
      verificationStopped: true,
    }),
    cleanup: async () => {
      calls += 1;
    },
  });
  assert.equal(calls, 0);
  assert.deepEqual(result.decision.reasons, [
    'process-or-container-unconfirmed',
  ]);
});

it('preserves a failed worker even when its old handoff still says review pending', async () => {
  const failedLaunch = () => {
    const child = new EventEmitter();
    child.pid = 124;
    queueMicrotask(() => child.emit('close', 1, null));
    return child;
  };
  const result = await supervisePostJob({
    root,
    issueNumber: 42,
    handoffPath,
    auditPath,
    sessionId: 'one',
    command: ['node', 'worker.mjs'],
    launch: failedLaunch,
    inspectStop: async () => ({
      workerExited: true,
      attemptContainersStopped: true,
      verificationStopped: true,
    }),
    cleanup: async () => assert.fail('failed worker must be preserved'),
  });
  assert.deepEqual(result.decision.reasons, ['worker-not-successful']);
});
