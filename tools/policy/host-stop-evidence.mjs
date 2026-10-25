import { spawnSync } from 'node:child_process';
import { createRootlessContainerOperations } from './worker-container-lifecycle.mjs';

export function inspectWindowsProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return 'inconclusive';
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

export async function inspectHostStop({
  issueNumber,
  headSha,
  workerPid,
  handoff,
  inspectProcess = inspectWindowsProcess,
  containers = createRootlessContainerOperations(),
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
