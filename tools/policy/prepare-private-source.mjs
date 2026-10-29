import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  inspectRestrictedWorkspace,
  runWorkspaceInspection,
} from './run-restricted-worker.mjs';

const helper = readFileSync(
  new URL('./copy-private-source.py', import.meta.url),
  'utf8',
);
const sha = /^[a-f0-9]{40,64}$/;
const digest = /^[a-f0-9]{64}$/;
const attemptPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const gitEnvironment = [
  'GIT_NO_REPLACE_OBJECTS=1',
  'GIT_CONFIG_NOSYSTEM=1',
  'GIT_CONFIG_GLOBAL=/dev/null',
  'GIT_CONFIG_COUNT=0',
  'GIT_ATTR_NOSYSTEM=1',
  'GIT_OPTIONAL_LOCKS=0',
];

function safePath(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= 512 &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !value.includes(':') &&
    !/[\x00-\x1f\x7f]/.test(value) &&
    value
      .split('/')
      .every(
        (part) =>
          part &&
          part !== '.' &&
          part !== '..' &&
          part !== '.git' &&
          part !== '.gitmodules',
      ) &&
    value !== '.incomplete' &&
    value !== 'manifest.json'
  );
}

function scoped(name, scopes) {
  return scopes.some((scope) => name === scope || name.startsWith(`${scope}/`));
}

function nulPaths(value) {
  if (typeof value !== 'string' || (value && !value.endsWith('\0')))
    throw new Error('Incomplete source path evidence.');
  return value ? value.slice(0, -1).split('\0') : [];
}

/** Trusted, inert source preparation. No worker or publication path calls this yet. */
export function preparePrivateSourceCopy({
  issueNumber,
  attemptId,
  workspace,
  privateRoot,
  expectedBranch,
  expectedRevision,
  expectedFingerprint,
  authorizedChangePaths,
  protectedPaths,
  signal,
  runCommand = runWorkspaceInspection,
  inspectWorkspace = inspectRestrictedWorkspace,
}) {
  if (
    !Number.isSafeInteger(issueNumber) ||
    issueNumber < 1 ||
    !attemptPattern.test(attemptId ?? '') ||
    typeof workspace !== 'string' ||
    !path.posix.isAbsolute(workspace) ||
    typeof privateRoot !== 'string' ||
    !path.posix.isAbsolute(privateRoot) ||
    !expectedBranch?.startsWith(`issue/${issueNumber}-`) ||
    !sha.test(expectedRevision ?? '') ||
    !digest.test(expectedFingerprint ?? '') ||
    !Array.isArray(authorizedChangePaths) ||
    !authorizedChangePaths.every(safePath) ||
    !Array.isArray(protectedPaths) ||
    protectedPaths.length === 0 ||
    !protectedPaths.every(safePath) ||
    typeof runCommand !== 'function' ||
    typeof inspectWorkspace !== 'function'
  )
    throw new Error('Trusted private source identity and scope are required.');
  const deadline = Date.now() + 45_000;
  const run = (args, options = {}) => {
    if (signal?.aborted) throw new Error('Private source capture cancelled.');
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Private source capture timed out.');
    const command =
      args[0] === 'git' ? ['env', ...gitEnvironment, ...args] : args;
    return runCommand(command, {
      ...options,
      timeout: Math.min(options.timeout ?? remaining, remaining),
      maxBuffer: options.maxBuffer ?? 2 * 1024 * 1024,
    });
  };
  const inspect = () =>
    inspectWorkspace(issueNumber, expectedBranch, undefined, {
      workspace,
      runCommand: run,
    });
  const matches = (state) =>
    state?.headRevision === expectedRevision &&
    state.fingerprint === expectedFingerprint &&
    state.workspacePath === workspace;
  // Git status can invoke clean/process filters from repository-local config.
  // Read config first: this command does not inspect working-file contents.
  const config = nulPaths(
    run(['git', '-C', workspace, 'config', '--includes', '--null', '--list']),
  );
  if (
    config.some((entry) =>
      /^filter\..+\.(?:clean|process|smudge)(?:\n|$)/i.test(entry),
    )
  )
    throw new Error('External Git filters are not allowed during capture.');
  const before = inspect();
  if (!matches(before)) throw new Error('Private source identity is stale.');
  if (
    before.changes.some(
      (name) =>
        !safePath(name) ||
        scoped(name, protectedPaths) ||
        !scoped(name, authorizedChangePaths),
    )
  )
    throw new Error('Source changes exceed the authorized scope.');
  const git = (...args) =>
    run([
      'git',
      '--no-optional-locks',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.untrackedCache=false',
      '-c',
      'core.ignorestat=false',
      '-C',
      workspace,
      ...args,
    ]);
  const all = nulPaths(
    git('ls-files', '--cached', '--others', '--exclude-standard', '-z'),
  );
  if (
    all.length > 1_000 ||
    new Set(all).size !== all.length ||
    all.some((name) => !safePath(name))
  )
    throw new Error('Source file manifest is unsafe or too large.');
  const paths = all.filter((name) => !scoped(name, protectedPaths)).sort();
  if (before.changes.some((name) => !all.includes(name)))
    throw new Error(
      'Deleted source files require a later lifecycle milestone.',
    );
  const ignored = nulPaths(
    git(
      'ls-files',
      '--others',
      '--ignored',
      '--exclude-standard',
      '--directory',
      '-z',
    ),
  ).filter((name) => name.endsWith('/'));
  const prepared = JSON.parse(
    run(
      [
        'python3',
        '-I',
        '-',
        'prepare',
        workspace,
        privateRoot,
        attemptId,
        expectedRevision,
        expectedFingerprint,
        JSON.stringify(paths),
        JSON.stringify(ignored),
      ],
      { input: helper, maxBuffer: 2 * 1024 * 1024 },
    ),
  );
  if (
    prepared.attemptId !== attemptId ||
    prepared.sourceRevision !== expectedRevision ||
    prepared.sourceFingerprint !== expectedFingerprint ||
    !digest.test(prepared.contentDigest ?? '') ||
    !Array.isArray(prepared.files) ||
    prepared.files.length !== paths.length ||
    prepared.files.some((file, index) => file?.path !== paths[index])
  )
    throw new Error('Private source manifest does not match the request.');
  const after = inspect();
  if (!matches(after))
    throw new Error('Source changed during private capture.');
  if (signal?.aborted) throw new Error('Private source capture cancelled.');
  const finalized = JSON.parse(
    run(
      [
        'python3',
        '-I',
        '-',
        'finalize',
        privateRoot,
        attemptId,
        expectedRevision,
        expectedFingerprint,
        prepared.contentDigest,
      ],
      { input: helper, maxBuffer: 1024 },
    ),
  );
  if (
    finalized.attemptId !== attemptId ||
    finalized.contentDigest !== prepared.contentDigest
  )
    throw new Error('Private source finalization failed.');
  return Object.freeze({
    ...prepared,
    privatePath: path.posix.join(privateRoot, attemptId, 'workspace'),
  });
}
