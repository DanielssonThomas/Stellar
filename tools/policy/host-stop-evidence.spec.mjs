import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inspectHostStop } from './host-stop-evidence.mjs';

const headSha = 'a'.repeat(40);
const handoff = {
  headSha,
  task: { issueNumber: 42, owner: 'worker:peon' },
  attempts: [{ attemptNumber: 1 }, { attemptNumber: 2 }],
};

describe('trusted host stop inspection', () => {
  it('requires fresh process and exact Windows/WSL attempt container states', async () => {
    const inspected = [];
    const stopped = await inspectHostStop({
      issueNumber: 42,
      headSha,
      workerPid: 123,
      handoff,
      inspectProcess: async () => 'exited',
      containers: {
        inspect: async (name) => {
          inspected.push(name);
          return 'absent';
        },
      },
    });
    assert.equal(stopped.workerExited, true);
    assert.equal(stopped.attemptContainersStopped, true);
    assert.equal(stopped.verificationStopped, true);
    assert.deepEqual(inspected, [
      'stellar-peon-worker-42-1',
      'stellar-peon-meter-42-1',
      'stellar-peon-verify-42-1',
      'stellar-peon-worker-42-2',
      'stellar-peon-meter-42-2',
      'stellar-peon-verify-42-2',
    ]);
  });
  it('preserves work for running processes, containers, or inconclusive WSL state', async () => {
    for (const [processState, containerState] of [
      ['running', 'absent'],
      ['exited', 'running'],
      ['exited', 'inconclusive'],
    ]) {
      const result = await inspectHostStop({
        issueNumber: 42,
        headSha,
        workerPid: 123,
        handoff,
        inspectProcess: async () => processState,
        containers: { inspect: async () => containerState },
      });
      assert.equal(
        result.workerExited &&
          result.attemptContainersStopped &&
          result.verificationStopped,
        false,
      );
    }
  });
  it('rejects omitted or reordered attempt history and wrong binding', async () => {
    for (const badHandoff of [
      { ...handoff, attempts: [] },
      { ...handoff, attempts: [{ attemptNumber: 2 }] },
      { ...handoff, headSha: 'b'.repeat(40) },
    ])
      await assert.rejects(
        inspectHostStop({
          issueNumber: 42,
          headSha,
          workerPid: 123,
          handoff: badHandoff,
        }),
      );
  });
});
