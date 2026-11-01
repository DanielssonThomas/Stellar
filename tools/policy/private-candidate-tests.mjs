/** Inert, attempt-local repository checks for a quarantined candidate. */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertExactPrivateCandidate,
  preparePrivateCandidateTestCopy,
  recordPrivateCandidateTestEvidence,
  verifyPrivateCandidate,
  verifyPrivateCandidateTestCopy,
} from './private-candidate.mjs';
import {
  buildRestrictedVerificationArgs,
  runWorkspaceInspection,
} from './run-restricted-worker.mjs';
import {
  createRootlessContainerOperations,
  stopAndConfirmContainer,
} from './worker-container-lifecycle.mjs';
import { trustedPeonWorkerImage } from './supervised-peon-run.mjs';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const trustedFiles = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'];
// Reviewed Git blob bytes and the Windows CRLF checkout form of the same text.
// A lockfile or manifest content change needs a reviewed update to these pins.
const reviewedTextDigests = Object.freeze({
  'package.json': Object.freeze([
    '2e32448de66f08f47fcd051a92e23838d46898e0a017bc8f7809bf50b8e29a02',
    'feccff9bbc42112bea23a6448202498c54d8f13435de321136989d47bfc870fe',
    '5638695381ffdc62b5d4aa1e83f99853c82e66db4d4c5fd86b009ce5b127bcb6',
    'ccea48e999b785ee50ab325e8080ae38d38a41ec2c8fea5b6ea7befc14cb437a',
    '956dc7c4f7f9f16f2c32f5d3ed9cde80c2f85284a9039fdcc112b06488201b16',
    'c6f05ef970e4cb589ba5487b77913d4c73c651d47045643e9125377343d0c087',
    '27eee43a49a2a1e8da6901dc478d2bd41784da96c020520edaa2d978fe14aa9d',
    '425e9cd72c54fe88e19c7531f8a0468993ba8388fc229daf8ad6fcbf510fa15a',
  ]),
  'pnpm-lock.yaml': Object.freeze([
    '4428c08045dd973b66f15a16f0bb5e977f199d43e800671c16a03ca8137d5f7f',
    '9f7d2f801be4f1c6bc6b9bea5c6a7a3ffe64e0b7ee69fab9a4a1b3a8cf4b5fc0',
  ]),
  'pnpm-workspace.yaml': Object.freeze([
    'a7bce599f23df0a210f951cc11d96e278b5feaeb15fcaab23141e78555ea28f8',
    '38b19ec0162220facfe1cb4f244b43b236d6fe487a0218fb33216738bbb3e04c',
  ]),
});
const trustedCacheLockDigest = reviewedTextDigests['pnpm-lock.yaml'][1];
const pinnedPackageManager = JSON.parse(
  readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'),
).packageManager;
const checks = Object.freeze({
  'nx-project-discovery': Object.freeze([
    'pnpm',
    'exec',
    'nx',
    'show',
    'projects',
    '--json',
  ]),
  'ui-atoms-lint': Object.freeze([
    'pnpm',
    'exec',
    'nx',
    'run',
    'ui-atoms:lint',
  ]),
  'ui-atoms-test': Object.freeze([
    'pnpm',
    'exec',
    'nx',
    'run',
    'ui-atoms:test',
  ]),
  'ui-atoms-build': Object.freeze([
    'pnpm',
    'exec',
    'nx',
    'run',
    'ui-atoms:build',
  ]),
  'ui-molecules-discovery': Object.freeze([
    'pnpm',
    'exec',
    'nx',
    'show',
    'project',
    'ui-molecules',
    '--json',
  ]),
  'ui-molecules-lint': Object.freeze([
    'pnpm',
    'exec',
    'nx',
    'run',
    'ui-molecules:lint',
  ]),
  'ui-molecules-test': Object.freeze([
    'pnpm',
    'exec',
    'node',
    'tools/policy/run-ui-molecules-tests.mjs',
    '--require-agent-status',
  ]),
  'ui-molecules-build': Object.freeze([
    'pnpm',
    'exec',
    'nx',
    'run',
    'ui-molecules:build',
  ]),
});
export function trustedMoleculeCheckCommands() {
  return Object.fromEntries(
    [
      'ui-molecules-discovery',
      'ui-molecules-lint',
      'ui-molecules-test',
      'ui-molecules-build',
    ].map((name) => [name, [...checks[name]]]),
  );
}
const installCommand = Object.freeze([
  'pnpm',
  'install',
  '--offline',
  '--frozen-lockfile',
  '--ignore-scripts',
  '--package-import-method=copy',
  '--store-dir',
  '/store',
]);
const storeStatusCommand = Object.freeze([
  'pnpm',
  'store',
  'status',
  '--store-dir',
  '/store',
]);
const active = new Set();
const maxDiagnosticBytes = 4096;

function safeRoot(value) {
  return (
    typeof value === 'string' &&
    path.posix.isAbsolute(value) &&
    path.posix.normalize(value) === value &&
    (process.platform !== 'win32' || value.startsWith('/home/peon/')) &&
    !/[\\,:=\x00-\x1f\x7f]/.test(value)
  );
}

function overlaps(a, b) {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function sanitizeTestDiagnostic(value) {
  const clean = value
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gi,
      '[REDACTED]',
    )
    .replace(/\b(Bearer)\s+[^\s,;]+/gi, '$1 [REDACTED]')
    .replace(
      /\b((?:api[-_ ]?key|token|secret|password)\s*[:=]\s*)[^\s,;]+/gi,
      '$1[REDACTED]',
    )
    .replace(/:\/\/[^\s/@:]+:[^\s/@]+@/g, '://[REDACTED]@');
  const bytes = Buffer.from(clean, 'utf8');
  if (bytes.length <= maxDiagnosticBytes) return clean;
  let end = maxDiagnosticBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

export function classifyOfflineDependencyFailure(result) {
  if (
    result.exitCode === 0 &&
    !result.error &&
    !result.timedOut &&
    !result.cancelled &&
    !result.signal
  )
    return null;
  if (
    result.error ||
    result.timedOut ||
    result.cancelled ||
    !Number.isSafeInteger(result.exitCode) ||
    result.signal
  )
    return 'inconclusive';
  if (/ERR_PNPM_NO_OFFLINE_META\b/.test(result.diagnostic))
    return 'missing-offline-metadata';
  if (/ERR_PNPM_NO_OFFLINE_TARBALL\b/.test(result.diagnostic))
    return 'missing-offline-content';
  if (
    /ERR_PNPM_(?:OUTDATED_LOCKFILE|FROZEN_LOCKFILE_WITH_OUTDATED_LOCKFILE)\b/.test(
      result.diagnostic,
    )
  )
    return 'lockfile-mismatch';
  return 'install-failed';
}

export function validateReviewedDependencyInputs(candidate) {
  for (const name of trustedFiles) {
    const entry = candidate.files.find((file) => file.path === name);
    if (!entry || !reviewedTextDigests[name].includes(entry.sha256))
      throw new Error(
        `Candidate ${name} differs from reviewed dependency input.`,
      );
  }
  if (
    pinnedPackageManager !==
    'pnpm@10.28.2+sha512.41872f037ad22f7348e3b1debbaf7e867cfd448f2726d9cf74c08f19507c31d2c8e7a11525b983febc2df640b5438dee6023ebb1f84ed43cc2d654d2bc326264'
  )
    throw new Error('Reviewed pnpm pin changed.');
  if (
    candidate.files.some((file) =>
      /(^|\/)(?:\.npmrc|\.pnpmfile\.cjs|pnpmfile\.cjs)$/.test(file.path),
    )
  )
    throw new Error(
      'Candidate package-manager hooks or configuration are not admitted.',
    );
  return trustedCacheLockDigest;
}

function runGit(workspace, args, runCommand) {
  return runCommand(
    [
      'env',
      '-i',
      'PATH=/usr/bin:/bin',
      'HOME=/dev/null',
      'GIT_CONFIG_NOSYSTEM=1',
      'GIT_CONFIG_GLOBAL=/dev/null',
      'GIT_CONFIG_COUNT=0',
      'GIT_NO_REPLACE_OBJECTS=1',
      'GIT_ATTR_NOSYSTEM=1',
      'GIT_OPTIONAL_LOCKS=0',
      'GIT_AUTHOR_NAME=Stellar Test',
      'GIT_AUTHOR_EMAIL=test@example.invalid',
      'GIT_COMMITTER_NAME=Stellar Test',
      'GIT_COMMITTER_EMAIL=test@example.invalid',
      'git',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.hooksPath=/dev/null',
      '-C',
      workspace,
      ...args,
    ],
    { timeout: 20_000, maxBuffer: 4096 },
  ).trim();
}

function prepareDisposableGit(workspace, runCommand = runWorkspaceInspection) {
  if (!safeRoot(workspace)) throw new Error('Unsafe disposable Git workspace.');
  runGit(
    workspace,
    [
      'init',
      '--quiet',
      '--template=/dev/null',
      '--initial-branch=private-test',
    ],
    runCommand,
  );
  runGit(workspace, ['add', '--all'], runCommand);
  const tree = runGit(workspace, ['write-tree'], runCommand);
  const commit = runGit(
    workspace,
    ['commit-tree', tree, '-m', 'Disposable candidate test'],
    runCommand,
  );
  runGit(
    workspace,
    ['update-ref', 'refs/heads/private-test', commit],
    runCommand,
  );
  if (
    runGit(workspace, ['remote'], runCommand) !== '' ||
    runGit(workspace, ['status', '--porcelain'], runCommand) !== ''
  )
    throw new Error('Disposable Git metadata is not isolated and clean.');
  return commit;
}

/** Prepare only attempt-local tooling for the #138 worker, never shared source. */
export async function preparePrivatePilotDependencies(
  options,
  privateCopy,
  {
    runCommand = runWorkspaceInspection,
    launch = launchPodman,
    confirmTermination = stopAndConfirmContainer,
    inspectContainer = (name) =>
      createRootlessContainerOperations().inspect(name, 1500),
  } = {},
) {
  const onPhase = options.onPhase ?? (() => {});
  if (typeof onPhase !== 'function')
    throw new Error('Trusted pilot dependency phase observer is required.');
  const attemptId = `issue-138-attempt-${options.attemptNumber}`;
  const testRoot = '/home/peon/stellar-private-pilot-deps';
  const testPath = path.posix.join(testRoot, attemptId, 'workspace');
  if (
    options.issueNumber !== 138 ||
    privateCopy?.schema !== 'stellar.private-source/v1' ||
    privateCopy.attemptId !== attemptId ||
    privateCopy.privatePath !==
      path.posix.join(options.privateRoot, attemptId, 'workspace') ||
    options.testRoot !== testRoot ||
    !safeRoot(options.privateRoot) ||
    !safeRoot(options.candidateRoot) ||
    !safeRoot(options.trustedProtectedRoot) ||
    [
      options.privateRoot,
      options.candidateRoot,
      options.trustedProtectedRoot,
    ].some((root) => overlaps(root, testRoot)) ||
    options.signal?.aborted
  )
    throw new Error(
      'Exact #138 private pilot dependency identity is required.',
    );
  const lockDigest = validateReviewedDependencyInputs(privateCopy);
  if (options.cacheRoot !== `/home/peon/stellar-dependency-cache/${lockDigest}`)
    throw new Error('Pilot dependency cache is not pinned to the lockfile.');
  const cacheStore = `${options.cacheRoot}/store`;
  const cacheSize = Number(
    runCommand(['du', '-sb', '--', cacheStore], {
      timeout: 5_000,
      maxBuffer: 1024,
    }).split(/\s+/)[0],
  );
  if (
    runCommand(['stat', '-c', '%u:%a', '--', options.cacheRoot], {
      timeout: 5_000,
      maxBuffer: 1024,
    }).trim() !== `${options.uid}:700` ||
    runCommand(['realpath', '-e', cacheStore], {
      timeout: 5_000,
      maxBuffer: 1024,
    }).trim() !== cacheStore ||
    runCommand(['sha256sum', `${options.cacheRoot}/pnpm-lock.yaml`], {
      timeout: 5_000,
      maxBuffer: 1024,
    }).split(' ')[0] !== lockDigest ||
    runCommand(['find', cacheStore, '-type', 'l', '-print', '-quit'], {
      timeout: 5_000,
      maxBuffer: 1024,
    }).trim() ||
    runCommand(
      [
        'find',
        cacheStore,
        '!',
        '-type',
        'f',
        '!',
        '-type',
        'd',
        '-print',
        '-quit',
      ],
      { timeout: 5_000, maxBuffer: 1024 },
    ).trim() ||
    !Number.isSafeInteger(cacheSize) ||
    cacheSize > 2 * 1024 ** 3
  )
    throw new Error('Trusted offline pilot cache is missing or unsafe.');
  runCommand(
    ['mkdir', '-m', '700', '--', path.posix.join(testRoot, attemptId)],
    {
      timeout: 5_000,
      maxBuffer: 1024,
    },
  );
  runCommand(['cp', '-a', '--', privateCopy.privatePath, testPath], {
    timeout: 45_000,
    maxBuffer: 1024,
  });
  await onPhase('workspace-copied');
  const gitCommit = prepareDisposableGit(testPath, runCommand);
  runCommand(
    [
      'cp',
      '-a',
      '--reflink=auto',
      '--',
      cacheStore,
      path.posix.join(testRoot, attemptId, 'store'),
    ],
    { timeout: 60_000, maxBuffer: 1024 },
  );
  await onPhase('cache-copied');
  const candidate = {
    attemptId,
    privatePath: privateCopy.privatePath,
  };
  const install = await runNamedCandidateCheck(
    options,
    candidate,
    testPath,
    installCommand,
    launch,
    confirmTermination,
    inspectContainer,
  );
  if (classifyOfflineDependencyFailure(install) !== null)
    throw new Error('Attempt-local offline dependency installation failed.');
  await onPhase('dependencies-installed');
  const store = await runNamedCandidateCheck(
    options,
    candidate,
    testPath,
    storeStatusCommand,
    launch,
    confirmTermination,
    inspectContainer,
  );
  if (classifyOfflineDependencyFailure(store) !== null)
    throw new Error('Attempt-local dependency store integrity failed.');
  await onPhase('store-verified');
  if (
    runCommand(['realpath', '-e', `${testPath}/node_modules`], {
      timeout: 5_000,
      maxBuffer: 1024,
    }).trim() !== `${testPath}/node_modules` ||
    runGit(testPath, ['remote'], runCommand) !== '' ||
    runGit(testPath, ['rev-parse', 'HEAD'], runCommand) !== gitCommit
  )
    throw new Error('Disposable pilot tooling changed after preparation.');
  return Object.freeze({ dependencyRoot: testPath, gitCommit, cacheSize });
}

export function buildCandidateTestArgs(options, candidate, testPath, command) {
  const toolingPhase = [installCommand, storeStatusCommand].some(
    (allowed) => JSON.stringify(command) === JSON.stringify(allowed),
  );
  const roots = [
    options.privateRoot,
    options.candidateRoot,
    candidate.privatePath,
    options.trustedProtectedRoot,
    options.cacheRoot,
    '/home/peon/workspaces',
  ];
  if (
    !safeRoot(options.testRoot) ||
    !safeRoot(testPath) ||
    roots.some((root) => !safeRoot(root) || overlaps(options.testRoot, root)) ||
    testPath !==
      path.posix.join(options.testRoot, candidate.attemptId, 'workspace') ||
    !Array.isArray(command) ||
    ![installCommand, storeStatusCommand, ...Object.values(checks)].some(
      (allowed) => JSON.stringify(command) === JSON.stringify(allowed),
    )
  )
    throw new Error(
      'Exact disposable test mount and named command are required.',
    );
  const args = buildRestrictedVerificationArgs({
    issueNumber: options.issueNumber,
    attemptNumber: options.attemptNumber,
    image: trustedPeonWorkerImage,
    uid: options.uid,
    gid: options.gid,
    protectedPaths: options.protectedPaths,
    command,
  });
  const root = args.findIndex(
    (item) =>
      item.startsWith('--mount=') && item.includes(',dst=/workspace,rw'),
  );
  if (root < 0) throw new Error('Restricted verifier root mount changed.');
  args[root] = `--mount=type=bind,src=${testPath},dst=/workspace,rw`;
  args.splice(
    root + 1,
    0,
    `--mount=type=bind,src=${path.posix.join(options.testRoot, candidate.attemptId, 'store')},dst=/store,${options.requireExactTestSource && !toolingPhase ? 'ro' : 'rw'}`,
  );
  if (options.requireExactTestSource && !toolingPhase)
    args.splice(
      root + 2,
      0,
      `--mount=type=bind,src=${testPath}/node_modules,dst=/workspace/node_modules,ro`,
      ...['libs/ui/atoms/node_modules', 'libs/ui/molecules/node_modules'].map(
        (name) =>
          `--mount=type=bind,src=${testPath}/${name},dst=/workspace/${name},ro`,
      ),
      `--mount=type=bind,src=${testPath}/.git,dst=/workspace/.git,ro`,
    );
  for (const protectedPath of options.protectedPaths) {
    const suffix = `,dst=/workspace/${protectedPath},ro`;
    const index = args.findIndex(
      (item) => item.startsWith('--mount=') && item.endsWith(suffix),
    );
    if (index < 0) throw new Error('Restricted protected mount changed.');
    args[index] =
      `--mount=type=bind,src=${path.posix.join(options.trustedProtectedRoot, protectedPath)},dst=/workspace/${protectedPath},ro`;
  }
  const imageIndex = args.indexOf(trustedPeonWorkerImage);
  args.splice(
    imageIndex,
    0,
    '--env=NX_DAEMON=false',
    '--env=NX_CACHE_DIRECTORY=/tmp/nx-cache',
    '--env=NX_WORKSPACE_DATA_DIRECTORY=/tmp/nx-workspace-data',
    '--env=CI=true',
    '--entrypoint=corepack',
  );
  if (args.some((item) => item.includes('src=/home/peon/workspaces/')))
    throw new Error('Authoritative source mount is forbidden.');
  return Object.freeze(args);
}

async function launchPodman(args, { signal, timeoutMs = 90_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(
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
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    const chunks = [];
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    const capture = (chunk) => {
      const data = Buffer.from(chunk);
      if (bytes >= maxDiagnosticBytes * 2) {
        truncated = true;
        return;
      }
      const remaining = maxDiagnosticBytes * 2 - bytes;
      if (remaining > 0) chunks.push(data.subarray(0, remaining));
      bytes = Math.min(maxDiagnosticBytes * 2, bytes + data.length);
      if (data.length > remaining) truncated = true;
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    let settled = false;
    let timer;
    const finish = (exitCode, error, exitSignal = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve({
        exitCode,
        error,
        signal: exitSignal,
        timedOut,
        cancelled,
        diagnostic: sanitizeTestDiagnostic(
          Buffer.concat(chunks).toString('utf8'),
        ),
        truncated,
      });
    };
    const abort = () => {
      cancelled = true;
      try {
        child.kill();
      } catch {
        /* Exact container inspection decides. */
      }
      finish(null, null);
    };
    timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        /* Exact container inspection decides. */
      }
      finish(null, null);
    }, timeoutMs);
    child.once('error', (error) => finish(null, error));
    child.once('exit', (code, exitSignal) => finish(code, null, exitSignal));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

async function runNamedCandidateCheck(
  options,
  candidate,
  testPath,
  command,
  launch,
  confirmTermination,
  inspectContainer,
) {
  const name = `stellar-peon-verify-${options.issueNumber}-${options.attemptNumber}`;
  if (options.signal?.aborted)
    throw new Error('Repository verification cancelled.');
  if ((await inspectContainer(name)) !== 'absent')
    throw new Error(
      'Exact verifier container is already present or uncertain.',
    );
  const args = buildCandidateTestArgs(options, candidate, testPath, command);
  if (options.signal?.aborted)
    throw new Error('Repository verification cancelled.');
  let result;
  try {
    result = await launch(args, { signal: options.signal });
  } finally {
    const stopped = await confirmTermination(name);
    if (!stopped?.confirmed || !['absent', 'stopped'].includes(stopped.state))
      throw new Error(
        'Verifier termination is uncertain; candidate stays quarantined.',
      );
  }
  return result;
}

/** No production dispatcher calls this function. Test results grant no publication authority. */
export async function runPrivateCandidateChecks(
  options,
  candidate,
  {
    runCommand = runWorkspaceInspection,
    verifyIntegrity = verifyPrivateCandidate,
    launch = launchPodman,
    confirmTermination = stopAndConfirmContainer,
    inspectContainer = (name) =>
      createRootlessContainerOperations().inspect(name, 1500),
    onPhase = () => {},
  } = {},
) {
  if (typeof onPhase !== 'function')
    throw new Error('Trusted candidate test phase check is required.');
  const { testRoot, cacheRoot, checkNames } = options;
  if (
    !safeRoot(testRoot) ||
    !safeRoot(cacheRoot) ||
    [
      cacheRoot,
      options.privateRoot,
      options.candidateRoot,
      candidate.privatePath,
      options.trustedProtectedRoot,
      '/home/peon/workspaces',
    ].some((root) => !safeRoot(root) || overlaps(testRoot, root)) ||
    !Array.isArray(checkNames) ||
    !checkNames.length ||
    checkNames.length > 4 ||
    new Set(checkNames).size !== checkNames.length ||
    checkNames.some((name) => !Object.hasOwn(checks, name)) ||
    options.signal?.aborted
  )
    throw new Error('Trusted named checks and disposable roots are required.');
  const lockDigest = validateReviewedDependencyInputs(candidate);
  if (cacheRoot !== `/home/peon/stellar-dependency-cache/${lockDigest}`)
    throw new Error('Dependency cache is not bound to the exact lockfile.');
  if (active.has(candidate.attemptId))
    throw new Error('Attempt tests are already active.');
  active.add(candidate.attemptId);
  try {
    assertExactPrivateCandidate(options, candidate, runCommand);
    const integrity = await verifyIntegrity(options, candidate, {
      runCommand,
      confirmTermination,
    });
    if (
      integrity?.candidateDigest !== candidate.contentDigest ||
      integrity.terminationConfirmed !== true
    )
      throw new Error('Independent candidate integrity is unconfirmed.');
    const { testPath } = preparePrivateCandidateTestCopy(
      options,
      candidate,
      testRoot,
      runCommand,
    );
    const gitCommit = prepareDisposableGit(testPath, runCommand);
    const verifyInputs = () => {
      if (options.requireExactTestSource)
        verifyPrivateCandidateTestCopy(
          options,
          candidate,
          testRoot,
          runCommand,
        );
    };
    verifyInputs();
    await onPhase('git-prepared');
    const cacheStore = `${cacheRoot}/store`;
    const cacheSize = Number(
      runCommand(['du', '-sb', cacheStore], {
        timeout: 5000,
        maxBuffer: 1024,
      }).split(/\s+/)[0],
    );
    if (
      runCommand(['stat', '-c', '%u:%a', '--', cacheRoot], {
        timeout: 5000,
        maxBuffer: 1024,
      }).trim() !== `${options.uid}:700` ||
      runCommand(['realpath', '-e', cacheStore], {
        timeout: 5000,
        maxBuffer: 1024,
      }).trim() !== cacheStore ||
      runCommand(['sha256sum', `${cacheRoot}/pnpm-lock.yaml`], {
        timeout: 5000,
        maxBuffer: 1024,
      }).split(' ')[0] !== lockDigest ||
      runCommand(['find', cacheStore, '-type', 'l', '-print', '-quit'], {
        timeout: 5000,
        maxBuffer: 1024,
      }).trim() ||
      runCommand(
        [
          'find',
          cacheStore,
          '!',
          '-type',
          'f',
          '!',
          '-type',
          'd',
          '-print',
          '-quit',
        ],
        {
          timeout: 5000,
          maxBuffer: 1024,
        },
      ).trim() ||
      !Number.isSafeInteger(cacheSize) ||
      cacheSize > 2 * 1024 * 1024 * 1024
    )
      throw new Error('Trusted dependency cache is missing or unsafe.');
    await onPhase('cache-preflight', { cacheSize });
    runCommand(
      [
        'cp',
        '-a',
        '--reflink=auto',
        '--',
        cacheStore,
        path.posix.join(testRoot, candidate.attemptId, 'store'),
      ],
      { timeout: 60_000, maxBuffer: 1024 },
    );
    await onPhase('cache-copied');
    const install = await runNamedCandidateCheck(
      options,
      candidate,
      testPath,
      installCommand,
      launch,
      confirmTermination,
      inspectContainer,
    );
    verifyInputs();
    await onPhase('dependencies-installed');
    const installPassed =
      install.exitCode === 0 &&
      !install.error &&
      !install.timedOut &&
      !install.cancelled &&
      !install.signal;
    const storeStatus = installPassed
      ? await runNamedCandidateCheck(
          options,
          candidate,
          testPath,
          storeStatusCommand,
          launch,
          confirmTermination,
          inspectContainer,
        )
      : null;
    if (storeStatus) {
      verifyInputs();
      await onPhase('store-checked');
    }
    const storePassed =
      storeStatus?.exitCode === 0 &&
      !storeStatus.error &&
      !storeStatus.timedOut &&
      !storeStatus.cancelled &&
      !storeStatus.signal;
    const dependencyFailure = !installPassed
      ? classifyOfflineDependencyFailure(install)
      : storePassed
        ? null
        : storeStatus.error ||
            storeStatus.timedOut ||
            storeStatus.cancelled ||
            !Number.isSafeInteger(storeStatus.exitCode) ||
            storeStatus.signal
          ? 'inconclusive'
          : 'store-integrity-failed';
    const results = [];
    let state = 'dependencies-unavailable';
    if (installPassed && storePassed) {
      if (options.requireExactTestSource)
        for (const name of [
          'node_modules',
          'libs/ui/atoms/node_modules',
          'libs/ui/molecules/node_modules',
          '.git',
        ])
          if (
            runCommand(['realpath', '-e', `${testPath}/${name}`], {
              timeout: 5_000,
              maxBuffer: 1024,
            }).trim() !== `${testPath}/${name}`
          )
            throw new Error('Disposable test tooling path was substituted.');
      state = 'tests-passed';
      for (const name of checkNames) {
        if (options.signal?.aborted) {
          state = 'inconclusive';
          break;
        }
        const result = await runNamedCandidateCheck(
          options,
          candidate,
          testPath,
          checks[name],
          launch,
          confirmTermination,
          inspectContainer,
        );
        verifyInputs();
        results.push({
          name,
          exitCode: result.exitCode,
          diagnostic: result.diagnostic,
          truncated: result.truncated,
        });
        await onPhase(`check:${name}`);
        if (
          result.error ||
          result.timedOut ||
          result.cancelled ||
          !Number.isSafeInteger(result.exitCode) ||
          result.signal
        ) {
          state = 'inconclusive';
          break;
        }
        if (result.exitCode !== 0) state = 'tests-failed';
        assertExactPrivateCandidate(options, candidate, runCommand, {
          allowRecorded: true,
        });
      }
    } else if (dependencyFailure === 'inconclusive') {
      state = 'inconclusive';
    }
    if (options.signal?.aborted) state = 'inconclusive';
    verifyInputs();
    assertExactPrivateCandidate(options, candidate, runCommand, {
      allowRecorded: true,
    });
    const evidence = {
      schema: 'stellar.private-repository-tests/v1',
      attemptId: candidate.attemptId,
      candidateDigest: candidate.contentDigest,
      integrity: 'verified',
      dependencyStatus:
        installPassed && storePassed ? 'available' : 'unavailable',
      dependencyFailure,
      status: state,
      gitCommit,
      installation: {
        exitCode: install.exitCode,
        diagnostic: install.diagnostic,
        truncated: install.truncated,
      },
      storeIntegrity: storeStatus && {
        exitCode: storeStatus.exitCode,
        diagnostic: storeStatus.diagnostic,
        truncated: storeStatus.truncated,
      },
      checks: results,
    };
    recordPrivateCandidateTestEvidence(
      options,
      candidate,
      testRoot,
      evidence,
      runCommand,
    );
    return Object.freeze(evidence);
  } finally {
    active.delete(candidate.attemptId);
  }
}
