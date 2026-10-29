/** Inert private output collection and exact-candidate verification. */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  buildRestrictedVerificationArgs,
  runWorkspaceInspection,
} from './run-restricted-worker.mjs';
import { stopAndConfirmContainer } from './worker-container-lifecycle.mjs';
import { trustedPeonWorkerImage } from './supervised-peon-run.mjs';

const helper = readFileSync(
  new URL('./copy-private-source.py', import.meta.url),
  'utf8',
);
const hex = /^[a-f0-9]{64}$/;
const revision = /^[a-f0-9]{40,64}$/;
const authoritativeRoot = '/home/peon/workspaces';
const image = trustedPeonWorkerImage;
const helperInputLimit = 2 * 1024 * 1024;
const framedHelperBootstrap = `import json,sys
size_line=sys.stdin.buffer.readline(16)
if not size_line.endswith(b'\\n') or not size_line[:-1].isdigit(): raise SystemExit(1)
size=int(size_line)
if size > 65536: raise SystemExit(1)
source=sys.stdin.buffer.read(size)
if len(source) != size: raise SystemExit(1)
payload=sys.stdin.buffer.read(${helperInputLimit + 1})
if len(payload) > ${helperInputLimit}: raise SystemExit(1)
REQUEST=json.loads(payload)
exec(compile(source,'<trusted-private-helper>','exec'),{'__name__':'__main__','REQUEST':REQUEST})`;

function positive(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function safeRoot(value) {
  return (
    typeof value === 'string' &&
    path.posix.isAbsolute(value) &&
    path.posix.normalize(value) === value &&
    value !== '/' &&
    (process.platform !== 'win32' || value.startsWith('/home/peon/')) &&
    !/[\\,:=\x00-\x1f\x7f]/.test(value)
  );
}

function overlaps(a, b) {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function safePath(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= 512 &&
    !/[\\,:=\x00-\x1f\x7f]/.test(value) &&
    value
      .split('/')
      .every(
        (part) =>
          part &&
          part !== '.' &&
          part !== '..' &&
          part !== '.git' &&
          part !== '.gitmodules',
      )
  );
}

function identity(options) {
  const {
    issueNumber,
    attemptNumber,
    privateCopy,
    privateRoot,
    candidateRoot,
    expectedRevision,
    expectedFingerprint,
    expectedBaselineDigest,
  } = options;
  const attemptId = `issue-${issueNumber}-attempt-${attemptNumber}`;
  if (
    !positive(issueNumber) ||
    !positive(attemptNumber) ||
    !safeRoot(privateRoot) ||
    !safeRoot(candidateRoot) ||
    overlaps(privateRoot, candidateRoot) ||
    overlaps(privateRoot, authoritativeRoot) ||
    overlaps(candidateRoot, authoritativeRoot) ||
    !revision.test(expectedRevision ?? '') ||
    !hex.test(expectedFingerprint ?? '') ||
    !hex.test(expectedBaselineDigest ?? '') ||
    privateCopy?.schema !== 'stellar.private-source/v1' ||
    privateCopy.attemptId !== attemptId ||
    privateCopy.sourceRevision !== expectedRevision ||
    privateCopy.sourceFingerprint !== expectedFingerprint ||
    privateCopy.contentDigest !== expectedBaselineDigest ||
    privateCopy.privatePath !==
      path.posix.join(privateRoot, attemptId, 'workspace') ||
    !Array.isArray(privateCopy.files)
  )
    throw new Error('Exact finalized private source identity is required.');
  const baseline = { ...privateCopy };
  delete baseline.privatePath;
  return { attemptId, baseline };
}

function callHelper(
  args,
  {
    runCommand = runWorkspaceInspection,
    timeout = 45_000,
    maxBuffer = 2 * 1024 * 1024,
    request,
  } = {},
) {
  const source = Buffer.from(helper, 'utf8');
  const payload =
    request === undefined ? null : Buffer.from(JSON.stringify(request), 'utf8');
  if (payload && source.length + payload.length > helperInputLimit)
    throw new Error('Candidate request exceeds the trusted input limit.');
  const command = payload
    ? ['python3', '-I', '-c', framedHelperBootstrap, ...args]
    : ['python3', '-I', '-', ...args];
  const input = payload
    ? Buffer.concat([Buffer.from(`${source.length}\n`), source, payload])
    : helper;
  return JSON.parse(
    runCommand(command, {
      input,
      timeout,
      maxBuffer,
    }),
  );
}

function exactCandidate(candidate, options) {
  const { attemptId } = identity(options);
  if (
    candidate?.schema !== 'stellar.private-candidate/v1' ||
    candidate.attemptId !== attemptId ||
    candidate.sourceRevision !== options.expectedRevision ||
    candidate.sourceFingerprint !== options.expectedFingerprint ||
    candidate.baselineDigest !== options.expectedBaselineDigest ||
    !hex.test(candidate.contentDigest ?? '') ||
    candidate.privatePath !==
      path.posix.join(options.candidateRoot, attemptId, 'workspace') ||
    !Array.isArray(candidate.files) ||
    !Array.isArray(candidate.changes)
  )
    throw new Error('Candidate identity does not match the attempt.');
  return attemptId;
}

function verifyCandidateFiles(candidate, options, runCommand) {
  const attemptId = exactCandidate(candidate, options);
  const persisted = callHelper(
    [
      'verify-candidate',
      options.candidateRoot,
      attemptId,
      options.expectedRevision,
      options.expectedFingerprint,
      options.expectedBaselineDigest,
      candidate.contentDigest,
    ],
    { runCommand, timeout: 15_000 },
  );
  const expected = { ...candidate };
  delete expected.privatePath;
  if (JSON.stringify(persisted) !== JSON.stringify(expected))
    throw new Error('Candidate manifest changed.');
  return persisted;
}

/** Caller supplies the trusted launcher-completion promise, never a worker claim. */
export async function collectPrivateCandidate(
  options,
  {
    runCommand = runWorkspaceInspection,
    confirmTermination = stopAndConfirmContainer,
  } = {},
) {
  const { attemptId, baseline } = identity(options);
  const {
    issueNumber,
    attemptNumber,
    candidateRoot,
    privateRoot,
    expectedRevision,
    expectedFingerprint,
    expectedBaselineDigest,
    authorizedChangePaths,
    protectedPaths,
    workerCompletion,
    signal,
  } = options;
  if (
    !Array.isArray(authorizedChangePaths) ||
    !authorizedChangePaths.length ||
    !authorizedChangePaths.every(safePath) ||
    new Set(authorizedChangePaths).size !== authorizedChangePaths.length ||
    !Array.isArray(protectedPaths) ||
    !protectedPaths.length ||
    !protectedPaths.every(safePath) ||
    new Set(protectedPaths).size !== protectedPaths.length ||
    !workerCompletion ||
    typeof workerCompletion.then !== 'function' ||
    signal?.aborted
  )
    throw new Error('Trusted completion and output scope are required.');
  const settled = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 10_000);
    workerCompletion.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        clearTimeout(timer);
        resolve(false);
      },
    );
  });
  if (!settled || signal?.aborted)
    throw new Error(
      'Worker completion is uncertain; output remains quarantined.',
    );
  const workerName = `stellar-peon-worker-${issueNumber}-${attemptNumber}`;
  const stopped = await confirmTermination(workerName);
  if (!stopped?.confirmed || !['absent', 'stopped'].includes(stopped.state))
    throw new Error('Exact worker termination is unconfirmed.');
  const manifest = callHelper(
    [
      'collect',
      privateRoot,
      candidateRoot,
      attemptId,
      expectedRevision,
      expectedFingerprint,
      expectedBaselineDigest,
    ],
    {
      runCommand,
      request: {
        baseline,
        allowed: authorizedChangePaths,
        protected: protectedPaths,
      },
    },
  );
  if (signal?.aborted)
    throw new Error(
      'Output collection cancelled; candidate stays quarantined.',
    );
  const candidate = {
    ...manifest,
    privatePath: path.posix.join(candidateRoot, attemptId, 'workspace'),
  };
  verifyCandidateFiles(candidate, options, runCommand);
  return Object.freeze(candidate);
}

const integrityCode = `import hashlib,json,os,stat,sys
m=json.load(open('/candidate-manifest.json',encoding='utf-8'))
if m['contentDigest'] != sys.argv[1]: raise SystemExit(71)
protected=set(json.loads(sys.argv[2]))
expected={e['path']:e for e in m['files']}
found={}
for root,dirs,files in os.walk('/workspace',followlinks=False):
  for name in dirs:
    p=os.path.join(root,name)
    if not stat.S_ISDIR(os.lstat(p).st_mode): raise SystemExit(72)
  for name in files:
    p=os.path.join(root,name)
    info=os.lstat(p)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1: raise SystemExit(73)
    rel=os.path.relpath(p,'/workspace')
    if rel in protected: continue
    with open(p,'rb') as handle: data=handle.read(8388609)
    found[rel]={'path':rel,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'mode':format(info.st_mode & 0o777,'03o')}
if found != expected: raise SystemExit(74)
print('candidate integrity passed')`;

/** Reuses the existing restricted verifier flags, changing only trusted mounts. */
export function buildPrivateVerificationArgs(options, candidate) {
  const attemptId = exactCandidate(candidate, options);
  const {
    issueNumber,
    attemptNumber,
    trustedProtectedRoot,
    protectedPaths,
    candidateRoot,
    uid,
    gid,
  } = options;
  if (
    !safeRoot(trustedProtectedRoot) ||
    overlaps(trustedProtectedRoot, candidateRoot) ||
    overlaps(trustedProtectedRoot, authoritativeRoot) ||
    !Array.isArray(protectedPaths) ||
    !protectedPaths.length ||
    !protectedPaths.every(safePath)
  )
    throw new Error('Trusted protected verification mounts are required.');
  const args = buildRestrictedVerificationArgs({
    issueNumber,
    attemptNumber,
    image,
    uid,
    gid,
    protectedPaths,
    command: [
      '-I',
      '-c',
      integrityCode,
      candidate.contentDigest,
      JSON.stringify(protectedPaths),
    ],
    writablePaths: undefined,
  });
  const rootMount = args.findIndex(
    (item) =>
      item.startsWith('--mount=') && item.includes(',dst=/workspace,rw'),
  );
  if (rootMount < 0) throw new Error('Restricted verifier root mount changed.');
  args[rootMount] =
    `--mount=type=bind,src=${candidate.privatePath},dst=/workspace,ro`;
  for (const [protectedIndex, protectedPath] of protectedPaths.entries()) {
    const destination = `,dst=/workspace/${protectedPath},ro`;
    const index = args.findIndex(
      (item) => item.startsWith('--mount=') && item.endsWith(destination),
    );
    if (index < 0) throw new Error('Restricted protected mount changed.');
    args[index] =
      `--mount=type=bind,src=${path.posix.join(trustedProtectedRoot, protectedPath)},dst=/tmp/stellar-protected-${protectedIndex},ro`;
  }
  args.splice(
    args.indexOf(image),
    0,
    `--mount=type=bind,src=${path.posix.join(candidateRoot, attemptId, 'manifest.json')},dst=/candidate-manifest.json,ro`,
    '--entrypoint=python3',
  );
  if (
    args.filter((item) => item.startsWith('--mount=')).length !==
      protectedPaths.length + 2 ||
    args.some(
      (item) =>
        item.startsWith('--mount=') &&
        item.includes(`src=${authoritativeRoot}/`),
    )
  )
    throw new Error('Unexpected restricted verifier mounts.');
  return Object.freeze(args);
}

function launchVerifier(args) {
  const result = spawnSync(
    'wsl.exe',
    ['--distribution', 'Ubuntu', '--user', 'peon', '--exec', 'podman', ...args],
    { windowsHide: true, timeout: 30_000, maxBuffer: 4096 },
  );
  return {
    exitCode: result.status,
    error: result.error,
    signal: result.signal,
    stdout: result.stdout?.toString('utf8') ?? '',
  };
}

/** An accepted record is written only after exact candidate revalidation. */
export async function verifyPrivateCandidate(
  options,
  candidate,
  {
    runCommand = runWorkspaceInspection,
    launch = launchVerifier,
    confirmTermination = stopAndConfirmContainer,
  } = {},
) {
  const attemptId = exactCandidate(candidate, options);
  verifyCandidateFiles(candidate, options, runCommand);
  if (options.signal?.aborted) throw new Error('Verification cancelled.');
  for (const source of [
    options.trustedProtectedRoot,
    ...options.protectedPaths.map((name) =>
      path.posix.join(options.trustedProtectedRoot, name),
    ),
  ]) {
    if (
      runCommand(['realpath', '-e', source], {
        timeout: 5_000,
        maxBuffer: 1024,
      }).trim() !== source
    )
      throw new Error('Trusted verification mount source changed.');
  }
  const args = buildPrivateVerificationArgs(options, candidate);
  const name = `stellar-peon-verify-${options.issueNumber}-${options.attemptNumber}`;
  let result;
  try {
    result = await launch(args);
  } finally {
    const stopped = await confirmTermination(name);
    if (!stopped?.confirmed || !['absent', 'stopped'].includes(stopped.state))
      throw new Error(
        'Verifier termination is uncertain; candidate stays quarantined.',
      );
  }
  if (
    result.error ||
    result.signal ||
    result.exitCode !== 0 ||
    options.signal?.aborted
  )
    throw new Error(
      'Independent verification failed; candidate stays quarantined.',
    );
  verifyCandidateFiles(candidate, options, runCommand);
  const evidence = {
    schema: 'stellar.private-verification/v1',
    attemptId,
    candidateDigest: candidate.contentDigest,
    exitCode: 0,
    terminationConfirmed: true,
    diagnostic: 'candidate integrity passed',
  };
  callHelper(
    [
      'accept-candidate',
      options.candidateRoot,
      attemptId,
      options.expectedRevision,
      options.expectedFingerprint,
      options.expectedBaselineDigest,
      candidate.contentDigest,
      JSON.stringify(evidence),
    ],
    { runCommand, timeout: 15_000, maxBuffer: 1024 },
  );
  return Object.freeze(evidence);
}
