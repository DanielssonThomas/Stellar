import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { cancellationGraceMs } from './supervise-worker.mjs';
import {
  cancellationConfirmationTimeoutMs,
  confirmAttemptCleanup,
  createRootlessContainerOperations,
  stopAndConfirmContainer,
} from './worker-container-lifecycle.mjs';

const workerName = 'stellar-peon-worker-50-4';
const meterName = 'stellar-peon-meter-50-4';

function mockOperations({ states, stop }) {
  const inspected = [];
  const stopped = [];
  return {
    inspected,
    stopped,
    operations: {
      inspect: async (name) => {
        inspected.push(name);
        const state = states.get(name);
        if (state instanceof Error) throw state;
        return state ?? 'absent';
      },
      stop: async (name) => {
        stopped.push(name);
        return stop?.(name, states) ?? true;
      },
    },
  };
}

test('accepts natural worker completion before cancellation and auto-removal', async () => {
  const mock = mockOperations({
    states: new Map([
      [workerName, 'absent'],
      [meterName, 'absent'],
    ]),
  });
  const result = await confirmAttemptCleanup({
    workerName,
    meterName,
    completion: Promise.resolve(),
    isCompletionSettled: () => true,
    operations: mock.operations,
  });

  assert.deepEqual(result, {
    confirmed: true,
    workerState: 'absent',
    meterState: 'absent',
  });
  assert.deepEqual(mock.stopped, []);
});

test('confirms termination when the worker exits while stop is executing', async () => {
  const states = new Map([
    [workerName, 'running'],
    [meterName, 'absent'],
  ]);
  let completionResolve;
  const completion = new Promise((resolve) => {
    completionResolve = resolve;
  });
  const mock = mockOperations({
    states,
    stop: (name) => {
      states.set(name, 'absent');
      completionResolve();
      return true;
    },
  });
  const result = await confirmAttemptCleanup({
    workerName,
    meterName,
    completion,
    operations: mock.operations,
  });

  assert.equal(result.confirmed, true);
  assert.deepEqual(mock.stopped, [workerName]);
});

test('confirms a container already removed before inspection', async () => {
  const result = await stopAndConfirmContainer(workerName, {
    operations: mockOperations({ states: new Map() }).operations,
  });

  assert.deepEqual(result, { confirmed: true, state: 'absent' });
});

test('rejects unrelated service names and a sidecar from another attempt', async () => {
  const mock = mockOperations({ states: new Map() });
  const service = await stopAndConfirmContainer('qwen', {
    operations: mock.operations,
  });
  const mismatchedAttempt = await confirmAttemptCleanup({
    workerName,
    meterName: 'stellar-peon-meter-50-5',
    completion: Promise.resolve(),
    isCompletionSettled: () => true,
    operations: mock.operations,
  });

  assert.deepEqual(service, { confirmed: false, state: 'inconclusive' });
  assert.equal(mismatchedAttempt.confirmed, false);
  assert.deepEqual(mock.inspected, []);
  assert.deepEqual(mock.stopped, []);
});

test('accepts confirmed absence even when the stop command fails', async () => {
  const states = new Map([[workerName, 'running']]);
  const mock = mockOperations({
    states,
    stop: (name) => {
      states.set(name, 'absent');
      return false;
    },
  });
  const result = await stopAndConfirmContainer(workerName, {
    operations: mock.operations,
  });

  assert.deepEqual(result, { confirmed: true, state: 'absent' });
  assert.deepEqual(mock.stopped, [workerName]);
});

test('accepts launcher-confirmed cleanup at the shared deadline', async () => {
  const mock = mockOperations({
    states: new Map([
      [workerName, 'running'],
      [meterName, 'running'],
    ]),
  });
  const result = await confirmAttemptCleanup({
    workerName,
    meterName,
    completion: Promise.resolve({
      cleanup: { workerState: 'absent', meterState: 'stopped' },
    }),
    isCompletionSettled: () => true,
    operations: mock.operations,
    deadlineAt: Date.now(),
  });

  assert.deepEqual(result, {
    confirmed: true,
    workerState: 'absent',
    meterState: 'stopped',
  });
  assert.deepEqual(mock.inspected, []);
});

test('rejects a successful stop while the exact worker remains running', async () => {
  const states = new Map([[workerName, 'running']]);
  const mock = mockOperations({ states });
  const startedAt = Date.now();
  const result = await stopAndConfirmContainer(workerName, {
    operations: mock.operations,
    deadlineAt: startedAt + 100,
    sleep: async (duration) =>
      new Promise((resolve) => setTimeout(resolve, duration)),
  });

  assert.equal(result.confirmed, false);
  assert.equal(result.state, 'running');
  assert.ok(Date.now() - startedAt <= 200);
});

test('fails closed on inspection failure or malformed lifecycle state', async () => {
  for (const state of [new Error('private diagnostic'), 'mystery']) {
    const mock = mockOperations({ states: new Map([[workerName, state]]) });
    const result = await stopAndConfirmContainer(workerName, {
      operations: mock.operations,
    });
    assert.deepEqual(result, { confirmed: false, state: 'inconclusive' });
    assert.deepEqual(mock.stopped, []);
  }
});

test('does not confirm cleanup while the metering sidecar remains active', async () => {
  const states = new Map([
    [workerName, 'absent'],
    [meterName, 'running'],
  ]);
  const mock = mockOperations({ states });
  const result = await confirmAttemptCleanup({
    workerName,
    meterName,
    completion: Promise.resolve(),
    isCompletionSettled: () => true,
    operations: mock.operations,
    deadlineAt: Date.now() + 100,
  });

  assert.equal(result.confirmed, false);
  assert.equal(result.workerState, 'absent');
  assert.equal(result.meterState, 'running');
  assert.ok(mock.stopped.every((name) => name === meterName));
});

test('bounds cancellation when process completion remains pending', async () => {
  const mock = mockOperations({ states: new Map([[workerName, 'running']]) });
  const startedAt = Date.now();
  const result = await confirmAttemptCleanup({
    workerName,
    meterName,
    completion: new Promise(() => {}),
    isCompletionSettled: () => false,
    operations: mock.operations,
    deadlineAt: startedAt + 40,
  });

  assert.equal(result.confirmed, false);
  assert.ok(Date.now() - startedAt <= 120);
  assert.ok(cancellationConfirmationTimeoutMs < cancellationGraceMs);
});

test('uses the same bounded stop confirmation for restricted verification', async () => {
  const verificationName = 'stellar-peon-verify-50-9';
  const states = new Map([[verificationName, 'running']]);
  let completionResolve;
  const completion = new Promise((resolve) => {
    completionResolve = resolve;
  });
  const mock = mockOperations({
    states,
    stop: (name) => {
      states.set(name, 'absent');
      completionResolve();
      return false;
    },
  });
  const result = await confirmAttemptCleanup({
    workerName: verificationName,
    completion,
    operations: mock.operations,
  });

  assert.deepEqual(result, {
    confirmed: true,
    workerState: 'absent',
    meterState: 'absent',
  });
  assert.deepEqual(mock.stopped, [verificationName]);
});

test('uses an exact issue-attempt filter in rootless Podman inspection', async () => {
  let invoked;
  const operations = createRootlessContainerOperations({
    spawnProcess: (command, args) => {
      invoked = { command, args };
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      setImmediate(() => {
        child.stdout.end(
          JSON.stringify([{ Names: [workerName], State: 'running' }]),
        );
        child.emit('exit', 0);
      });
      return child;
    },
  });
  const state = await operations.inspect(workerName, 500);

  assert.equal(state, 'running');
  assert.equal(invoked.command, 'wsl.exe');
  assert.deepEqual(invoked.args.slice(-6), [
    'ps',
    '--all',
    '--filter',
    `name=^${workerName}$`,
    '--format',
    'json',
  ]);
  assert.ok(invoked.args.includes(`name=^${workerName}$`));
  assert.equal(invoked.args.includes('qwen'), false);
});
