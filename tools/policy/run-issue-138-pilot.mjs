/** Maintainer-only, #138-specific entry point. Never called by dispatch. */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { trustedMoleculeCheckCommands } from './private-candidate-tests.mjs';
import {
  inspectSingleUsePilotAuthority,
  issueSingleUsePilotAuthorization,
  runSingleUsePeonPilot,
  singleUsePilotStatePaths,
} from './single-use-peon-pilot.mjs';
import {
  inspectClaimedWorktree,
  trustedPeonWorkerImage,
} from './supervised-peon-run.mjs';
import {
  runWorkspaceInspection,
  verifyPinnedWorkerImageCompatibility,
} from './run-restricted-worker.mjs';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const issueNumber = 138;
const pilotNumber = 153;
const modelName = 'Qwen3.5-9B-Q5_K_S';
const modelImage =
  'ghcr.io/ggml-org/llama.cpp@sha256:c65f01343624f55848a82a6b653880e53399377a92b371975eb3303c1d5647e7';
const modelFile =
  '/home/peon/.local/share/stellar-peon-model/Qwen3.5-9B-Q5_K_S.gguf';
const modelDigest =
  'be88613a50ba792bd5a2bc07b74bcd97c9ed9dbac028d27a44c6888e712323c3';
const cacheDigest =
  '9f7d2f801be4f1c6bc6b9bea5c6a7a3ffe64e0b7ee69fab9a4a1b3a8cf4b5fc0';
const cacheRoot = `/home/peon/stellar-dependency-cache/${cacheDigest}`;
const attempts = Object.freeze(['issue-138-attempt-1', 'issue-138-attempt-2']);
const expectedChecks = Object.freeze({
  'ui-molecules-discovery': [
    'pnpm',
    'exec',
    'nx',
    'show',
    'project',
    'ui-molecules',
    '--json',
  ],
  'ui-molecules-lint': ['pnpm', 'exec', 'nx', 'run', 'ui-molecules:lint'],
  'ui-molecules-test': [
    'pnpm',
    'exec',
    'node',
    'tools/policy/run-ui-molecules-tests.mjs',
    '--require-agent-status',
  ],
  'ui-molecules-build': ['pnpm', 'exec', 'nx', 'run', 'ui-molecules:build'],
});
const modelCommand = Object.freeze([
  '--model',
  '/models/Qwen3.5-9B-Q5_K_S.gguf',
  '--alias',
  modelName,
  '--ctx-size',
  '65536',
  '--n-gpu-layers',
  '99',
  '--parallel',
  '1',
  '--batch-size',
  '128',
  '--ubatch-size',
  '32',
  '--flash-attn',
  'on',
  '--cache-type-k',
  'q8_0',
  '--cache-type-v',
  'q8_0',
  '--jinja',
  '--reasoning',
  'off',
  '--host',
  '0.0.0.0',
  '--port',
  '18435',
]);
const fields = Object.freeze([
  'issue',
  'pilot',
  'branch',
  'source-revision',
  'source-fingerprint',
  'session-id',
  'model',
  'independent-attempt',
  'correction-attempt',
  'approval',
]);

export function parsePilotArguments(argv) {
  const [operation, ...rest] = argv;
  if (!['preflight', 'authorize', 'execute'].includes(operation))
    throw new Error(
      'Choose exactly one operation: preflight, authorize, or execute.',
    );
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index]?.slice(2);
    if (
      !rest[index]?.startsWith('--') ||
      !fields.includes(key) ||
      Object.hasOwn(values, key) ||
      !rest[index + 1] ||
      rest[index + 1].startsWith('--')
    )
      throw new Error('Unexpected, duplicate, or missing pilot argument.');
    values[key] = rest[index + 1];
  }
  if (
    fields
      .filter((key) => key !== 'approval')
      .some((key) => !Object.hasOwn(values, key)) ||
    (operation === 'authorize'
      ? values.approval !== 'maintainer-exact-153'
      : Object.hasOwn(values, 'approval')) ||
    values.issue !== String(issueNumber) ||
    values.pilot !== String(pilotNumber) ||
    values.model !== modelName ||
    values['independent-attempt'] !== attempts[0] ||
    values['correction-attempt'] !== attempts[1] ||
    !/^issue\/138-[a-z0-9-]+$/.test(values.branch) ||
    !/^[a-f0-9]{40}$/.test(values['source-revision']) ||
    !/^[a-f0-9]{64}$/.test(values['source-fingerprint']) ||
    !/^[a-zA-Z0-9._:-]{1,128}$/.test(values['session-id'])
  )
    throw new Error(
      'Exact #138 pilot identity and all required arguments are necessary.',
    );
  return {
    operation,
    branch: values.branch,
    revision: values['source-revision'],
    fingerprint: values['source-fingerprint'],
    sessionId: values['session-id'],
  };
}

function wsl(args, timeout = 10_000, maxBuffer = 16 * 1024) {
  return runWorkspaceInspection(args, { timeout, maxBuffer }).trim();
}

function inspectHostCheckout() {
  const read = (args) => {
    const result = spawnSync(
      'git',
      [
        '--no-optional-locks',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.untrackedCache=false',
        '-C',
        repositoryRoot,
        ...args,
      ],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 1024,
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
          GIT_NO_REPLACE_OBJECTS: '1',
          GIT_ATTR_NOSYSTEM: '1',
          GIT_OPTIONAL_LOCKS: '0',
        },
      },
    );
    if (result.error || result.status !== 0)
      throw new Error('Trusted host checkout could not be inspected.');
    return result.stdout.trim();
  };
  read(['ls-files', '--error-unmatch', 'tools/policy/run-issue-138-pilot.mjs']);
  return {
    branch: read(['branch', '--show-current']),
    revision: read(['rev-parse', 'HEAD']),
    trackedClean:
      read(['status', '--porcelain=v1', '--untracked-files=no']) === '',
  };
}

function inspectModel() {
  const container = JSON.parse(
    wsl(
      ['podman', 'inspect', '--format', '{{json .}}', 'stellar-peon-qwen-9b'],
      5_000,
      128 * 1024,
    ),
  );
  const networks = container.NetworkSettings?.Networks ?? {};
  const modelNetwork = JSON.parse(
    wsl(['podman', 'network', 'inspect', 'stellar-peon-model']),
  );
  const health = JSON.parse(
    wsl(
      [
        'podman',
        'exec',
        'stellar-peon-qwen-9b',
        'curl',
        '-fsS',
        '--max-time',
        '3',
        'http://127.0.0.1:18435/health',
      ],
      5_000,
    ),
  );
  const digest = wsl(['sha256sum', modelFile], 25_000, 1024).split(/\s+/)[0];
  const fileMode = wsl(['stat', '-c', '%u:%a', '--', modelFile], 5_000, 128);
  const parentMode = wsl(
    ['stat', '-c', '%u:%a', '--', path.posix.dirname(modelFile)],
    5_000,
    128,
  );
  if (
    container.State?.Running !== true ||
    container.Config?.Image !== modelImage ||
    JSON.stringify(container.Config.Cmd) !== JSON.stringify(modelCommand) ||
    Object.keys(networks).length !== 1 ||
    !networks['stellar-peon-model']?.Aliases?.includes('peon-model') ||
    modelNetwork.length !== 1 ||
    modelNetwork[0].internal !== true ||
    Object.keys(container.HostConfig?.PortBindings ?? {}).length !== 0 ||
    !(container.HostConfig?.Binds ?? []).some((bind) =>
      bind.startsWith(`${modelFile}:/models/Qwen3.5-9B-Q5_K_S.gguf:ro`),
    ) ||
    health.status !== 'ok' ||
    digest !== modelDigest ||
    fileMode !== '1001:444' ||
    parentMode !== '1001:555'
  )
    throw new Error(
      'Existing 9B model identity, health, or isolation changed.',
    );
  return { name: modelName, healthy: true, route: 'peon-model:18435', digest };
}

function inspectCache() {
  const localLock = createHash('sha256')
    .update(readFileSync(path.join(repositoryRoot, 'pnpm-lock.yaml')))
    .digest('hex');
  const cacheLock = wsl(
    ['sha256sum', `${cacheRoot}/pnpm-lock.yaml`],
    5_000,
    1024,
  ).split(/\s+/)[0];
  const mode = wsl(['stat', '-c', '%u:%a', '--', cacheRoot], 5_000, 128);
  const store = `${cacheRoot}/store`;
  const realRoot = wsl(['realpath', '-e', cacheRoot], 5_000, 1024);
  const real = wsl(['realpath', '-e', store], 5_000, 1024);
  const size = Number(
    wsl(['du', '-sb', '--', store], 10_000, 1024).split(/\s+/)[0],
  );
  const link = wsl(
    ['find', store, '-type', 'l', '-print', '-quit'],
    10_000,
    1024,
  );
  const special = wsl(
    ['find', store, '!', '-type', 'f', '!', '-type', 'd', '-print', '-quit'],
    10_000,
    1024,
  );
  const rootLink = wsl(
    ['find', cacheRoot, '-maxdepth', '1', '-type', 'l', '-print', '-quit'],
    5_000,
    1024,
  );
  if (
    localLock !== cacheDigest ||
    cacheLock !== cacheDigest ||
    mode !== '1001:700' ||
    realRoot !== cacheRoot ||
    rootLink ||
    real !== store ||
    !Number.isSafeInteger(size) ||
    size > 2 * 1024 ** 3 ||
    link ||
    special
  )
    throw new Error('Exact offline dependency cache is missing or unsafe.');
  return { lockDigest: cacheDigest, storeBytes: size };
}

function inspectAttemptPaths() {
  const roots = [
    '/home/peon/stellar-private-pilot-source',
    '/home/peon/stellar-private-pilot-deps',
    '/home/peon/stellar-private-pilot-candidates',
    '/home/peon/stellar-private-pilot-tests',
    '/home/peon/stellar-private-pilot-protected',
  ];
  for (const root of roots)
    for (const attempt of attempts) {
      wsl(['test', '!', '-e', `${root}/${attempt}`], 5_000, 128);
      wsl(['test', '!', '-L', `${root}/${attempt}`], 5_000, 128);
    }
  const names = wsl(
    ['podman', 'ps', '-a', '--format', '{{.Names}}'],
    5_000,
  ).split(/\r?\n/);
  for (const attempt of [1, 2])
    for (const prefix of [
      'stellar-peon-worker',
      'stellar-peon-meter',
      'stellar-peon-verify',
    ])
      if (names.includes(`${prefix}-138-${attempt}`))
        throw new Error('A prior #138 attempt container still exists.');
  return true;
}

async function readPilotState() {
  const paths = singleUsePilotStatePaths(repositoryRoot);
  const root = await lstat(paths.root).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!root) return { kind: 'empty' };
  if (!root.isDirectory() || root.isSymbolicLink())
    throw new Error('Pilot state root is unsafe.');
  const names = (await readdir(paths.root)).sort();
  if (names.length === 0)
    throw new Error('Empty pilot state root requires trusted inspection.');
  if (
    JSON.stringify(names) !== JSON.stringify(['authorized.json', 'issued.json'])
  )
    throw new Error('Pilot state is used, incomplete, or requires recovery.');
  const records = [];
  for (const name of names) {
    const file = path.join(paths.root, name);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 8192)
      throw new Error('Pilot authorization file is unsafe.');
    records.push(JSON.parse(await readFile(file, 'utf8')));
  }
  if (JSON.stringify(records[0]) !== JSON.stringify(records[1]))
    throw new Error('Issued pilot authorization was substituted.');
  return { kind: 'authorized', authorization: records[0] };
}

async function inspectProduction(expected) {
  const current = await inspectSingleUsePilotAuthority({
    repositoryRoot,
    sessionId: expected.sessionId,
  });
  const windows = inspectClaimedWorktree(repositoryRoot, current.claim);
  const sourceDir = path.join(
    current.claim.worktreePath,
    'libs/ui/molecules/src',
  );
  const windowsFiles = readdirSync(sourceDir, { recursive: true });
  const linuxComponent = wsl(
    [
      'find',
      '/home/peon/workspaces/issue-138/libs/ui/molecules/src',
      '-iname',
      '*agent-status*',
      '-print',
      '-quit',
    ],
    5_000,
    1024,
  );
  verifyPinnedWorkerImageCompatibility({
    image: trustedPeonWorkerImage,
    trustedRepositoryRoot: repositoryRoot,
  });
  const config = readFileSync(
    path.join(repositoryRoot, 'tools/policy/peon-hermes-narrow-config.yaml'),
    'utf8',
  );
  const meterConfigured =
    /^  default: Qwen3\.5-9B-Q5_K_S\r?$/m.test(config) &&
    /^  base_url: http:\/\/peon-meter:18436\/v1\r?$/m.test(config);
  const diskFreeBytes = Number(
    wsl(['df', '-B1', '--output=avail', '/home/peon'], 5_000, 1024)
      .split(/\s+/)
      .at(-1),
  );
  return {
    host: inspectHostCheckout(),
    issue: current.issue,
    claim: current.claim,
    revision: current.revision,
    source: current.source,
    windows,
    componentAbsent:
      !windowsFiles.some((name) =>
        name.toLowerCase().includes('agent-status'),
      ) && !linuxComponent,
    model: inspectModel(),
    workerImage: trustedPeonWorkerImage,
    meterConfigured,
    cache: inspectCache(),
    diskFreeBytes,
    attemptsAbsent: inspectAttemptPaths(),
    checks: trustedMoleculeCheckCommands(),
    state: await readPilotState(),
  };
}

export function validatePilotEvidence(
  expected,
  evidence,
  operation,
  now = Date.now(),
) {
  const claim = evidence.claim;
  const labels =
    evidence.issue?.labels?.map((label) =>
      typeof label === 'string' ? label : label.name,
    ) ?? [];
  if (
    evidence.host?.branch !== 'develop' ||
    evidence.host.revision !== expected.revision ||
    evidence.host.trackedClean !== true ||
    evidence.issue?.number !== issueNumber ||
    evidence.issue.state !== 'OPEN' ||
    !labels.includes('worker:peon') ||
    !labels.includes('status:in-progress') ||
    !labels.includes('hermes-profile:narrow-coding') ||
    !labels.includes('hermes-workflow:minimal-coding') ||
    claim?.state !== 'active' ||
    claim.worker !== 'worker:peon' ||
    claim.sessionId !== expected.sessionId ||
    claim.branch !== expected.branch ||
    claim.target !== 'develop' ||
    !path.isAbsolute(claim.worktreePath ?? '') ||
    !Number.isFinite(Date.parse(claim.expiresAt)) ||
    Date.parse(claim.expiresAt) <= now ||
    evidence.revision !== expected.revision ||
    evidence.source?.headRevision !== expected.revision ||
    evidence.source.baseRevision !== expected.revision ||
    evidence.source.fingerprint !== expected.fingerprint ||
    evidence.source.clean !== true ||
    evidence.source.workspacePath !== '/home/peon/workspaces/issue-138' ||
    evidence.windows?.headRevision !== expected.revision ||
    evidence.windows.clean !== true ||
    evidence.componentAbsent !== true ||
    evidence.model?.name !== modelName ||
    evidence.model.healthy !== true ||
    evidence.model.digest !== modelDigest ||
    evidence.workerImage !== trustedPeonWorkerImage ||
    evidence.meterConfigured !== true ||
    evidence.cache?.lockDigest !== cacheDigest ||
    evidence.attemptsAbsent !== true ||
    !Number.isSafeInteger(evidence.diskFreeBytes) ||
    evidence.diskFreeBytes < 4 * 1024 ** 3 ||
    JSON.stringify(evidence.checks) !== JSON.stringify(expectedChecks)
  )
    throw new Error(
      'Exact #138 pilot preflight identity or resource check failed.',
    );
  if (operation === 'execute') {
    const authorization = evidence.state?.authorization;
    if (
      evidence.state?.kind !== 'authorized' ||
      authorization?.schema !== 'stellar.single-use-peon-pilot/v1' ||
      authorization.issueNumber !== issueNumber ||
      authorization.sessionId !== expected.sessionId ||
      authorization.branch !== expected.branch ||
      authorization.worktreePath !== claim.worktreePath ||
      authorization.sourceRevision !== expected.revision ||
      authorization.sourceFingerprint !== expected.fingerprint ||
      authorization.independentAttemptId !== attempts[0] ||
      authorization.correctionAttemptId !== attempts[1]
    )
      throw new Error('Exact issued pilot authorization is missing or stale.');
  } else if (evidence.state?.kind !== 'empty') {
    throw new Error('Pilot authorization already exists or is ambiguous.');
  }
  return {
    go: true,
    issueNumber,
    pilotNumber,
    sessionId: expected.sessionId,
    branch: expected.branch,
    revision: expected.revision,
    fingerprint: expected.fingerprint,
    model: evidence.model.name,
    workerImage: evidence.workerImage,
    cacheDigest,
    freeBytes: evidence.diskFreeBytes,
    attempts,
    state: evidence.state.kind,
  };
}

/** Injection is for disposable inert tests; the direct CLI always uses fixed production services. */
export async function runPilotOperation(
  argv,
  {
    inspect = inspectProduction,
    issueAuthorization = issueSingleUsePilotAuthorization,
    runPilot = runSingleUsePeonPilot,
    signalSource = process,
  } = {},
) {
  const expected = parsePilotArguments(argv);
  const controller = new AbortController();
  const onSignal = () => {
    if (!controller.signal.aborted)
      controller.abort(new Error('Pilot cancelled by operator.'));
  };
  signalSource.on('SIGINT', onSignal);
  signalSource.on('SIGTERM', onSignal);
  try {
    const evidence = await inspect(expected);
    controller.signal.throwIfAborted();
    const report = validatePilotEvidence(
      expected,
      evidence,
      expected.operation,
    );
    if (expected.operation === 'preflight') return report;
    const options = {
      repositoryRoot,
      sessionId: expected.sessionId,
      signal: controller.signal,
    };
    if (expected.operation === 'authorize') {
      const authorization = await issueAuthorization(options);
      controller.signal.throwIfAborted();
      if (
        authorization?.schema !== 'stellar.single-use-peon-pilot/v1' ||
        authorization.issueNumber !== issueNumber ||
        authorization.sessionId !== expected.sessionId ||
        authorization.branch !== expected.branch ||
        authorization.worktreePath !== evidence.claim.worktreePath ||
        authorization.sourceRevision !== expected.revision ||
        authorization.sourceFingerprint !== expected.fingerprint ||
        authorization.independentAttemptId !== attempts[0] ||
        authorization.correctionAttemptId !== attempts[1]
      )
        throw new Error(
          'Issued authorization differs from approved pilot identity.',
        );
      return {
        ...report,
        state: 'authorized',
        authorizationId: authorization.id,
      };
    }
    const result = await runPilot(options);
    controller.signal.throwIfAborted();
    return { ...report, state: 'finished', result };
  } finally {
    signalSource.off('SIGINT', onSignal);
    signalSource.off('SIGTERM', onSignal);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  runPilotOperation(process.argv.slice(2)).then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      process.stderr.write(
        `${JSON.stringify({ go: false, error: String(error?.message ?? error).slice(0, 512) })}\n`,
      );
      process.exitCode = 1;
    },
  );
}
