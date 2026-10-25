import { spawnSync } from 'node:child_process';
import { createRootlessContainerOperations } from './worker-container-lifecycle.mjs';

export function inspectHostProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return 'inconclusive';
  if (process.platform === 'linux') {
    const result = spawnSync('ps', ['-eo', 'pid=,pgid='], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    if (result.error || result.status !== 0) return 'inconclusive';
    const rows = result.stdout
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.trim().split(/\s+/).map(Number));
    if (
      !rows.every((row) => row.length === 2 && row.every(Number.isSafeInteger))
    )
      return 'inconclusive';
    return rows.some(
      ([processId, groupId]) => processId === pid || groupId === pid,
    )
      ? 'running'
      : 'exited';
  }
  if (process.platform !== 'win32') return 'inconclusive';
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress',
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 10_000 },
  );
  if (result.error || result.status !== 0) return 'inconclusive';
  try {
    const parsed = JSON.parse(result.stdout);
    const processes = Array.isArray(parsed) ? parsed : [parsed];
    if (
      !processes.every(
        (item) =>
          Number.isSafeInteger(item?.ProcessId) &&
          Number.isSafeInteger(item?.ParentProcessId),
      )
    )
      return 'inconclusive';
    const descendants = new Set([pid]);
    let priorSize;
    do {
      priorSize = descendants.size;
      for (const item of processes)
        if (descendants.has(item.ParentProcessId))
          descendants.add(item.ProcessId);
    } while (descendants.size !== priorSize);
    return processes.some((item) => descendants.has(item.ProcessId))
      ? 'running'
      : 'exited';
  } catch {
    return 'inconclusive';
  }
}

export function createLocalContainerOperations({ run = spawnSync } = {}) {
  return {
    async inspect(name, timeoutMs) {
      if (
        !/^stellar-peon-(?:worker|meter|verify)-[1-9]\d*-[1-9]\d*$/.test(name)
      )
        return 'inconclusive';
      const result = run(
        'podman',
        ['ps', '--all', '--filter', `name=^${name}$`, '--format', 'json'],
        { encoding: 'utf8', timeout: timeoutMs },
      );
      if (result.error || result.status !== 0) return 'inconclusive';
      try {
        const records = JSON.parse(result.stdout);
        if (!Array.isArray(records)) return 'inconclusive';
        if (records.length === 0) return 'absent';
        if (records.length !== 1) return 'inconclusive';
        const names = Array.isArray(records[0].Names)
          ? records[0].Names
          : [records[0].Names];
        if (names.length !== 1 || names[0] !== name) return 'inconclusive';
        const state = String(records[0].State ?? '').toLowerCase();
        if (['exited', 'stopped', 'created', 'configured'].includes(state))
          return 'stopped';
        if (['running', 'paused', 'stopping'].includes(state)) return 'running';
      } catch {
        /* A malformed response preserves the worktree. */
      }
      return 'inconclusive';
    },
  };
}

export async function inspectHostStop({
  issueNumber,
  headSha,
  workerPid,
  handoff,
  inspectProcess = inspectHostProcess,
  containers = process.platform === 'win32'
    ? createRootlessContainerOperations()
    : createLocalContainerOperations(),
}) {
  if (
    !Number.isSafeInteger(issueNumber) ||
    issueNumber < 1 ||
    !/^[0-9a-f]{40,64}$/.test(headSha ?? '') ||
    !Number.isSafeInteger(workerPid) ||
    workerPid < 1 ||
    handoff?.task?.issueNumber !== issueNumber ||
    handoff.headSha !== headSha ||
    !Array.isArray(handoff.attempts)
  )
    throw new Error('Trusted worker identity or durable handoff is missing.');
  const processState = await inspectProcess(workerPid);
  const isPeon =
    handoff.task.owner === 'worker:peon' ||
    handoff.attempts.some((attempt) => attempt.workerId === 'peon');
  const attempts = handoff.attempts.map(
    (attempt, index) => attempt.attemptNumber === index + 1,
  );
  if (attempts.includes(false))
    throw new Error('Peon attempt history is incomplete.');
  let attemptContainersStopped = true;
  let verificationStopped = true;
  const containerStates = [];
  if (isPeon) {
    if (handoff.attempts.length === 0)
      throw new Error('Peon attempt history is missing.');
    if (
      !handoff.attempts.some(
        (attempt) => !attempt.workerId || attempt.workerId === 'peon',
      )
    )
      throw new Error('Peon attempt identity is missing.');
    for (const { attemptNumber, workerId } of handoff.attempts) {
      if (workerId && workerId !== 'peon') continue;
      const states = {};
      for (const kind of ['worker', 'meter', 'verify']) {
        const name = `stellar-peon-${kind}-${issueNumber}-${attemptNumber}`;
        states[kind] = await containers.inspect(name, 1500);
      }
      containerStates.push({ attemptNumber, ...states });
      if (
        !['absent', 'stopped'].includes(states.worker) ||
        !['absent', 'stopped'].includes(states.meter)
      )
        attemptContainersStopped = false;
      if (!['absent', 'stopped'].includes(states.verify))
        verificationStopped = false;
    }
  }
  return {
    issueNumber,
    headSha,
    checkedAt: new Date().toISOString(),
    workerExited: processState === 'exited',
    attemptContainersStopped,
    verificationStopped,
    evidence: { workerPid, processState, containerStates },
  };
}
