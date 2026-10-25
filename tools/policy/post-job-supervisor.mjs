import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cleanupIssue } from './cleanup-lifecycle.mjs';
import { inspectHostStop } from './host-stop-evidence.mjs';

function options(argv) {
  const separator = argv.indexOf('--');
  if (separator < 0 || separator === argv.length - 1)
    throw new Error('A bounded worker command is required after --.');
  const args = {};
  for (let i = 0; i < separator; i += 2) {
    if (!argv[i]?.startsWith('--') || !argv[i + 1])
      throw new Error('Named supervisor options are required.');
    args[argv[i].slice(2)] = argv[i + 1];
  }
  return { args, command: argv.slice(separator + 1) };
}

export async function supervisePostJob({
  root,
  issueNumber,
  handoffPath,
  auditPath,
  sessionId,
  command,
  launch = spawn,
  inspectStop = inspectHostStop,
  cleanup = cleanupIssue,
}) {
  if (
    !Number.isSafeInteger(issueNumber) ||
    issueNumber < 1 ||
    ![root, handoffPath, auditPath].every((path) => isAbsolute(path ?? '')) ||
    !sessionId ||
    !Array.isArray(command) ||
    command.length < 1
  )
    throw new Error('Trusted post-job supervisor inputs are incomplete.');
  const child = launch(command[0], command.slice(1), {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
    detached: process.platform === 'linux',
  });
  if (!Number.isSafeInteger(child.pid) || child.pid < 1)
    throw new Error('Worker process identity is unavailable; preserve work.');
  const exit = await new Promise((resolveExit) => {
    child.once('error', (error) => resolveExit({ error: error.message }));
    child.once('close', (code, signal) => resolveExit({ code, signal }));
  });
  const handoff = JSON.parse(await readFile(handoffPath, 'utf8'));
  const stopped = await inspectStop({
    issueNumber,
    headSha: handoff.headSha,
    workerPid: child.pid,
    handoff,
  });
  if (
    exit.code !== 0 ||
    exit.signal ||
    exit.error ||
    !stopped.workerExited ||
    !stopped.attemptContainersStopped ||
    !stopped.verificationStopped
  )
    return {
      exit,
      decision: {
        eligible: false,
        reasons: [
          exit.code !== 0 || exit.signal || exit.error
            ? 'worker-not-successful'
            : 'process-or-container-unconfirmed',
        ],
      },
      stopped,
    };
  const decision = await cleanup({
    root,
    issueNumber,
    phase: 'post-job',
    handoffPath,
    stopped,
    auditPath,
    releaseSessionId: sessionId,
    remoteAuthorized: false,
  });
  return { exit, decision, stopped };
}

export async function main(argv = process.argv.slice(2)) {
  const { args, command } = options(argv);
  const result = await supervisePostJob({
    root: args.root,
    issueNumber: Number(args.issue),
    handoffPath: args.handoff,
    auditPath: args.audit,
    sessionId: args['session-id'],
    command,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.decision.eligible) process.exitCode = 2;
  return result;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
