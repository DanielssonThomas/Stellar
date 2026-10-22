import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const cancellationConfirmationTimeoutMs = 4_500;
const podmanCommandTimeoutMs = 1_500;
const lifecyclePollIntervalMs = 50;
const diagnosticLimitBytes = 8 * 1024;
const allowedContainerName =
  /^stellar-peon-(?:worker|meter|verify)-[1-9]\d*-[1-9]\d*$/;
const attemptContainerName =
  /^stellar-peon-(worker|verify|meter)-([1-9]\d*)-([1-9]\d*)$/;
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

function remainingMs(deadlineAt, now) {
  return Math.max(0, deadlineAt - now());
}

function waitForCompletion(completion, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(
      () => {
        if (settled) return;
        settled = true;
        resolve({ settled: false });
      },
      Math.max(0, timeoutMs),
    );
    Promise.resolve(completion).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ settled: true, value, fulfilled: true });
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ settled: true, error, fulfilled: false });
      },
    );
  });
}

function boundedStdout(stream) {
  const chunks = [];
  let bytes = 0;
  let truncated = false;
  stream?.on('data', (chunk) => {
    if (truncated) return;
    const buffer = Buffer.from(chunk);
    const remaining = diagnosticLimitBytes - bytes;
    if (buffer.length > remaining) {
      chunks.push(buffer.subarray(0, Math.max(0, remaining)));
      bytes = diagnosticLimitBytes;
      truncated = true;
    } else {
      chunks.push(buffer);
      bytes += buffer.length;
    }
  });
  return () => ({
    text: Buffer.concat(chunks).toString('utf8'),
    truncated,
  });
}

function runPodman(args, timeoutMs, spawnProcess = spawn) {
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    let readStdout;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ...result,
        stdout: readStdout?.() ?? { text: '', truncated: false },
      });
    };
    let child;
    try {
      child = spawnProcess(
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
        {
          cwd: repositoryRoot,
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
        },
      );
    } catch {
      resolve({
        code: null,
        timedOut: false,
        stdout: { text: '', truncated: false },
      });
      return;
    }
    readStdout = boundedStdout(child.stdout);
    child.once('error', () => finish({ code: null, timedOut: false }));
    child.once('exit', (code) => finish({ code, timedOut: false }));
    timer = setTimeout(
      () => {
        try {
          child.kill();
        } catch {
          // A failed kill is inconclusive; the caller will still fail closed.
        }
        finish({ code: null, timedOut: true });
      },
      Math.max(1, timeoutMs),
    );
  });
}

function parsePodmanState(stdout, expectedName) {
  if (stdout.truncated) return 'inconclusive';
  let records;
  try {
    records = JSON.parse(stdout.text);
  } catch {
    return 'inconclusive';
  }
  if (!Array.isArray(records)) return 'inconclusive';
  if (records.length === 0) return 'absent';
  if (records.length !== 1) return 'inconclusive';

  const record = records[0];
  const names = Array.isArray(record?.Names)
    ? record.Names
    : typeof record?.Names === 'string'
      ? [record.Names]
      : [];
  if (names.length !== 1 || names[0] !== expectedName) return 'inconclusive';

  const state = String(record.State ?? '').toLowerCase();
  if (['exited', 'stopped', 'created', 'configured'].includes(state))
    return 'stopped';
  if (['running', 'paused', 'stopping'].includes(state)) return 'running';
  return 'inconclusive';
}

export function createRootlessContainerOperations({
  spawnProcess = spawn,
} = {}) {
  return {
    async inspect(name, timeoutMs) {
      if (!allowedContainerName.test(name)) return 'inconclusive';
      const result = await runPodman(
        ['ps', '--all', '--filter', `name=^${name}$`, '--format', 'json'],
        timeoutMs,
        spawnProcess,
      );
      if (result.code !== 0 || result.timedOut) return 'inconclusive';
      return parsePodmanState(result.stdout, name);
    },
    async stop(name, timeoutMs) {
      if (!allowedContainerName.test(name)) return false;
      const result = await runPodman(
        ['stop', '--time', '1', name],
        timeoutMs,
        spawnProcess,
      );
      return result.code === 0 && !result.timedOut;
    },
  };
}

const rootlessContainerOperations = createRootlessContainerOperations();

export async function stopAndConfirmContainer(
  name,
  {
    operations = rootlessContainerOperations,
    deadlineAt = Date.now() + cancellationConfirmationTimeoutMs,
    now = Date.now,
    sleep = (duration) =>
      new Promise((resolve) => setTimeout(resolve, duration)),
  } = {},
) {
  if (!allowedContainerName.test(name))
    return { confirmed: false, state: 'inconclusive' };

  const getDeadlineAt =
    typeof deadlineAt === 'function' ? deadlineAt : () => deadlineAt;
  let state = 'inconclusive';
  while (remainingMs(getDeadlineAt(), now) > 0) {
    const remaining = remainingMs(getDeadlineAt(), now);
    try {
      state = await operations.inspect(name, remaining);
    } catch {
      return { confirmed: false, state: 'inconclusive' };
    }
    if (state === 'absent' || state === 'stopped')
      return { confirmed: true, state };
    if (state !== 'running') return { confirmed: false, state: 'inconclusive' };

    try {
      await operations.stop(
        name,
        Math.min(podmanCommandTimeoutMs, remainingMs(getDeadlineAt(), now)),
      );
    } catch {
      // Stop's result is advisory. A fresh exact-container inspection decides.
    }
    const waitMs = Math.min(
      lifecyclePollIntervalMs,
      remainingMs(getDeadlineAt(), now),
    );
    if (waitMs > 0) await sleep(waitMs);
  }
  return {
    confirmed: false,
    state: state === 'running' ? 'running' : 'inconclusive',
  };
}

export async function confirmAttemptCleanup({
  workerName,
  meterName,
  completion,
  isCompletionSettled = () => false,
  operations = rootlessContainerOperations,
  deadlineAt = Date.now() + cancellationConfirmationTimeoutMs,
  now = Date.now,
  sleep,
}) {
  const workerParts = workerName?.match(attemptContainerName);
  if (!workerParts || !['worker', 'verify'].includes(workerParts[1]))
    return {
      confirmed: false,
      workerState: 'inconclusive',
      meterState: 'inconclusive',
    };
  if (meterName) {
    const meterParts = meterName.match(attemptContainerName);
    if (
      !meterParts ||
      meterParts[1] !== 'meter' ||
      meterParts[2] !== workerParts[2] ||
      meterParts[3] !== workerParts[3] ||
      workerParts[1] !== 'worker'
    )
      return {
        confirmed: false,
        workerState: 'inconclusive',
        meterState: 'inconclusive',
      };
  }

  if (!isCompletionSettled()) {
    const remaining = remainingMs(deadlineAt, now);
    try {
      if (remaining > 0)
        await operations.stop(
          workerName,
          Math.min(podmanCommandTimeoutMs, remaining),
        );
    } catch {
      // A nonzero or failed stop can still be followed by confirmed absence.
    }
  }

  const completionResult = await waitForCompletion(
    completion,
    remainingMs(deadlineAt, now),
  );
  if (!completionResult.settled)
    return {
      confirmed: false,
      workerState: 'inconclusive',
      meterState: meterName ? 'inconclusive' : 'absent',
    };

  if (completionResult.fulfilled) {
    const cleanup = completionResult.value?.cleanup;
    const workerState = meterName ? cleanup?.workerState : cleanup?.state;
    const meterState = meterName ? cleanup?.meterState : 'absent';
    if (
      ['absent', 'stopped'].includes(workerState) &&
      ['absent', 'stopped'].includes(meterState)
    )
      return { confirmed: true, workerState, meterState };
  }

  const worker = await stopAndConfirmContainer(workerName, {
    operations,
    deadlineAt,
    now,
    ...(sleep ? { sleep } : {}),
  });
  const meter = meterName
    ? await stopAndConfirmContainer(meterName, {
        operations,
        deadlineAt,
        now,
        ...(sleep ? { sleep } : {}),
      })
    : { confirmed: true, state: 'absent' };
  return {
    confirmed: worker.confirmed && meter.confirmed,
    workerState: worker.state,
    meterState: meter.state,
  };
}
