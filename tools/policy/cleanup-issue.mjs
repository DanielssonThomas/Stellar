import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cleanupIssue } from './cleanup-lifecycle.mjs';

function options(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith('--') || !argv[index + 1])
      throw new Error('Cleanup requires named option/value pairs.');
    result[argv[index].slice(2)] = argv[index + 1];
  }
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const args = options(argv);
  const issueNumber = Number(args.issue);
  if (
    !Number.isSafeInteger(issueNumber) ||
    issueNumber < 1 ||
    !['post-job', 'merged'].includes(args.phase) ||
    ![args.root, args.handoff, args.receipt, args.audit].every(
      (path) => typeof path === 'string' && isAbsolute(path),
    )
  )
    throw new Error(
      'Usage: cleanup-issue.mjs --issue N --phase post-job|merged --root ABS --handoff ABS --receipt ABS --audit ABS [--session-id ID]',
    );
  const stopped = JSON.parse(await readFile(args.receipt, 'utf8'));
  if (
    stopped.issueNumber !== issueNumber ||
    !Number.isFinite(Date.parse(stopped.checkedAt)) ||
    Date.now() - Date.parse(stopped.checkedAt) > 300_000 ||
    Date.parse(stopped.checkedAt) > Date.now() + 30_000
  )
    throw new Error(
      'Fresh trusted process and container stop receipt is required.',
    );
  const result = await cleanupIssue({
    root: args.root,
    issueNumber,
    phase: args.phase,
    handoffPath: args.handoff,
    stopped,
    auditPath: args.audit,
    releaseSessionId: args['session-id'],
    remoteAuthorized:
      stopped.crossCloneSafe === true &&
      stopped.remoteDeletionAuthorized === true,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
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
