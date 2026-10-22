import { spawn, spawnSync } from 'node:child_process';
import { parseProtectedCodeowners } from './worker-integration-gate.mjs';
import { defaultLimits } from './supervise-worker.mjs';
import {
  buildWorkerImageInspectionArgs,
  verifyWorkerImageCompatibility,
} from './worker-image-compatibility.mjs';
import {
  cancellationConfirmationTimeoutMs,
  confirmAttemptCleanup,
  createRootlessContainerOperations,
  stopAndConfirmContainer,
} from './worker-container-lifecycle.mjs';

export { buildWorkerImageInspectionArgs };
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const distribution = 'Ubuntu';
const workerAccount = 'peon';
const workspaceRoot = '/home/peon/workspaces';
const workerSecret = 'stellar-worker-github-token';
const modelNetwork = 'stellar-peon-model';
const egressNetwork = 'stellar-peon-egress';
const workerNetwork = 'stellar-peon-worker';
const workerImageRepository = 'ghcr.io/stellar-ai-corp/hermes-worker';
const imagePattern =
  /^ghcr\.io\/stellar-ai-corp\/hermes-worker@sha256:[a-f0-9]{64}$/;
const diagnosticStreamLimitBytes = 8 * 1024;

export function inspectPinnedWorkerImageProxy(image) {
  const result = spawnSync(
    'wsl.exe',
    [
      '--distribution',
      distribution,
      '--user',
      workerAccount,
      '--exec',
      'podman',
      ...buildWorkerImageInspectionArgs(image),
    ],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 16 * 1024,
    },
  );
  if (result.error || result.status !== 0)
    return { status: result.status ?? 1, stdout: '' };
  return { status: 0, stdout: result.stdout };
}

export function verifyPinnedWorkerImageCompatibility({
  image,
  trustedRepositoryRoot = repositoryRoot,
  inspectImage = inspectPinnedWorkerImageProxy,
  readTrustedSource,
} = {}) {
  return verifyWorkerImageCompatibility({
    image,
    sourcePath: path.join(
      trustedRepositoryRoot,
      'tools/policy/peon-metering-proxy.mjs',
    ),
    inspectImage,
    ...(readTrustedSource ? { readTrustedSource } : {}),
  });
}

export function redactWorkerDiagnostics(value) {
  return (
    String(value ?? '')
      .replace(
        /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gi,
        '[REDACTED]',
      )
      .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, '$1 [REDACTED]')
      .replace(
        /^([ \t]*(?:authorization|proxy-authorization|cookie|set-cookie)\s*[:=])[^\r\n]*/gim,
        '$1 [REDACTED]',
      )
      .replace(
        /\b((?:GH_TOKEN|GITHUB_TOKEN|OPENAI_API_KEY|STELLAR_INTEGRATION_TOKEN|(?:api[-_ ]?key|token|secret|password))\s*[:=]\s*)[^\r\n]*/gi,
        '$1[REDACTED]',
      )
      .replace(/:\/\/[^/\s:@]+:[^/\s@]+@/g, '://[REDACTED]@')
      // Opaque values can be credentials even when they lack a known prefix.
      .replace(/\b[A-Za-z0-9+/=_-]{20,}\b/g, '[REDACTED]')
      .slice(-diagnosticStreamLimitBytes)
  );
}

export function captureBoundedDiagnosticStream(stream) {
  let output = Buffer.alloc(0);
  let totalBytes = 0;
  stream?.on('data', (chunk) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    totalBytes += bytes.length;
    output = Buffer.concat([output, bytes]).subarray(
      -diagnosticStreamLimitBytes,
    );
  });
  return () => ({
    text: redactWorkerDiagnostics(output.toString('utf8')),
    truncated: totalBytes > diagnosticStreamLimitBytes,
  });
}

function summarizeWorkerDiagnostics(diagnostics = {}) {
  const parts = [];
  for (const stream of ['stderr', 'stdout']) {
    const result = diagnostics[stream];
    if (!result?.text) continue;
    parts.push(`${stream}: ${redactWorkerDiagnostics(result.text)}`);
    if (result.truncated) parts.push(`${stream} truncated`);
  }
  return parts.join(' | ').replace(/\s+/g, ' ').slice(0, 1_400);
}

export function formatWorkerFailure({ exitCode, diagnostics }) {
  return [
    `Hermes exited with status ${exitCode ?? 1}.`,
    summarizeWorkerDiagnostics(diagnostics),
  ]
    .filter(Boolean)
    .join(' ');
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1)
    throw new Error(`${name} must be a positive integer.`);
  return number;
}

function runWsl(args, { input, timeout = 15000 } = {}) {
  const result = spawnSync('wsl.exe', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    windowsHide: true,
    timeout,
    ...(input === undefined ? {} : { input }),
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      (result.stderr || result.stdout || 'WSL command failed').trim(),
    );
  return result.stdout.trim();
}

function wslWorker(...args) {
  return runWsl([
    '--distribution',
    distribution,
    '--user',
    workerAccount,
    '--exec',
    ...args,
  ]);
}

async function stopRootlessContainer(name, options) {
  return stopAndConfirmContainer(name, options);
}

function assertAttemptNotCancelled(lifecycle) {
  if (
    lifecycle.cancellationDeadlineAt !== null &&
    lifecycle.cancellationDeadlineAt !== undefined
  )
    throw new Error('Worker attempt cancellation was requested before launch.');
}

function issueWorkspace(issueNumber) {
  return path.posix.join(workspaceRoot, `issue-${issueNumber}`);
}

export function buildPodmanArgs({
  issueNumber,
  image,
  uid,
  gid,
  command,
  protectedPaths,
  attemptNumber = 1,
}) {
  const number = positiveInteger(issueNumber, 'issueNumber');
  if (typeof image !== 'string' || !imagePattern.test(image))
    throw new Error(
      `Worker image must be ${workerImageRepository} pinned by a lowercase sha256 digest.`,
    );
  const userId = Number(uid);
  const groupId = Number(gid);
  if (!Number.isSafeInteger(userId) || userId < 1)
    throw new Error('Worker uid must be a positive integer.');
  if (!Number.isSafeInteger(groupId) || groupId < 1)
    throw new Error('Worker gid must be a positive integer.');
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    command.some(
      (argument) => typeof argument !== 'string' || argument.includes('\0'),
    )
  )
    throw new Error('A nonempty command argument list is required.');

  const workspace = issueWorkspace(number);
  if (
    !Array.isArray(protectedPaths) ||
    protectedPaths.length === 0 ||
    protectedPaths.some(
      (entry) =>
        typeof entry !== 'string' ||
        !entry ||
        entry.startsWith('/') ||
        /[\\,:=]/.test(entry) ||
        entry.split('/').some((part) => !part || part === '.' || part === '..'),
    )
  )
    throw new Error('Trusted protected paths are required for worker mounts.');
  return [
    'run',
    '--rm',
    '--init',
    '--pull=never',
    `--name=stellar-peon-worker-${number}-${positiveInteger(attemptNumber, 'attemptNumber')}`,
    '--userns=keep-id',
    `--user=${userId}:${groupId}`,
    `--network=${workerNetwork}`,
    '--http-proxy=false',
    '--read-only',
    '--cap-drop=all',
    '--security-opt=no-new-privileges',
    '--pids-limit=128',
    '--memory=4g',
    '--memory-swap=4g',
    '--cpus=2',
    '--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=512m',
    '--tmpfs=/tmp/.hermes:rw,nosuid,nodev,noexec,size=64m,mode=0777',
    `--mount=type=bind,src=${workspace},dst=/workspace,rw`,
    `--mount=type=bind,src=${path.posix.join(workspace, 'tools/policy/peon-hermes-config.yaml')},dst=/tmp/.hermes/config.yaml,ro`,
    ...protectedPaths.map(
      (entry) =>
        `--mount=type=bind,src=${path.posix.join(workspace, entry)},dst=/workspace/${entry},ro`,
    ),
    '--workdir=/workspace',
    '--env=HOME=/tmp',
    '--env=COREPACK_HOME=/opt/corepack',
    '--env=COREPACK_DEFAULT_TO_LATEST=0',
    '--env=COREPACK_ENABLE_NETWORK=0',
    '--env=NX_SKIP_NATIVE_FILE_CACHE=true',
    '--env=HERMES_HOME=/tmp/.hermes',
    '--env=HERMES_RUNTIME_DIR=/opt/hermes/tools',
    '--env=TMPDIR=/tmp',
    '--env=OPENAI_BASE_URL=http://peon-meter:18436/v1',
    '--env=OPENAI_API_KEY=stellar-local-meter',
    '--env=HTTPS_PROXY=http://peon-meter:3128',
    '--env=HTTP_PROXY=http://peon-meter:3128',
    '--env=https_proxy=http://peon-meter:3128',
    '--env=http_proxy=http://peon-meter:3128',
    '--env=NO_PROXY=localhost,127.0.0.1,peon-meter',
    `--secret=source=${workerSecret},type=env,target=GH_TOKEN`,
    image,
    ...command,
  ];
}

export function buildMeteringProxyArgs({
  name,
  image,
  uid,
  gid,
  maxModelTokens,
  maxToolCalls,
  initialModelTokens = 0,
  initialToolCalls = 0,
}) {
  if (!/^stellar-peon-meter-[1-9][0-9]*-[1-9][0-9]*$/.test(name ?? ''))
    throw new Error('Metering proxy name must identify one issue attempt.');
  if (typeof image !== 'string' || !imagePattern.test(image))
    throw new Error(
      'Metering proxy image must be pinned by a lowercase sha256 digest.',
    );
  const maxTokens = positiveInteger(maxModelTokens, 'maxModelTokens');
  const maxTools = positiveInteger(maxToolCalls, 'maxToolCalls');
  const initialTokens = Number(initialModelTokens);
  const initialTools = Number(initialToolCalls);
  if (
    maxTokens > 64_000 ||
    maxTools > 128 ||
    !Number.isSafeInteger(initialTokens) ||
    initialTokens < 0 ||
    initialTokens > maxTokens ||
    !Number.isSafeInteger(initialTools) ||
    initialTools < 0 ||
    initialTools > maxTools
  )
    throw new Error('Metering proxy budgets exceed trusted hard limits.');
  // Podman selects the first attached bridge as the proxy's default route.
  return [
    'run',
    '--detach',
    '--rm',
    '--init',
    '--pull=never',
    `--name=${name}`,
    '--userns=keep-id',
    `--user=${uid}:${gid}`,
    `--network=${egressNetwork}`,
    `--network=${workerNetwork}:alias=peon-meter`,
    `--network=${modelNetwork}`,
    '--http-proxy=false',
    '--read-only',
    '--cap-drop=all',
    '--security-opt=no-new-privileges',
    '--pids-limit=64',
    '--memory=512m',
    '--memory-swap=512m',
    '--cpus=1',
    '--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=64m',
    `--env=STELLAR_MODEL_UPSTREAM=http://peon-model:18435`,
    `--env=STELLAR_MAX_MODEL_TOKENS=${maxTokens}`,
    `--env=STELLAR_MAX_TOOL_CALLS=${maxTools}`,
    `--env=STELLAR_INITIAL_MODEL_TOKENS=${initialTokens}`,
    `--env=STELLAR_INITIAL_TOOL_CALLS=${initialTools}`,
    image,
    'node',
    '/opt/stellar-peon-metering-proxy.mjs',
  ];
}

function readMeterUsage(containerName) {
  const source =
    "fetch('http://127.0.0.1:18437/usage').then(r=>r.json()).then(x=>process.stdout.write(JSON.stringify(x)))";
  return JSON.parse(
    wslWorker('podman', 'exec', containerName, 'node', '-e', source),
  );
}

function waitForMeter(containerName) {
  const source =
    "fetch('http://127.0.0.1:18436/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      wslWorker('podman', 'exec', containerName, 'node', '-e', source);
      return;
    } catch {
      spawnSync(
        'wsl.exe',
        [
          '--distribution',
          distribution,
          '--user',
          workerAccount,
          '--exec',
          'sleep',
          '0.25',
        ],
        { cwd: repositoryRoot, windowsHide: true, timeout: 2000 },
      );
    }
  }
  throw new Error('Trusted metering proxy did not become healthy.');
}

function loadProtectedPaths() {
  const remote = spawnSync('git', ['remote', 'get-url', 'origin'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  const allowedRemotes = [
    'https://github.com/DanielssonThomas/Stellar.git',
    'git@github.com:DanielssonThomas/Stellar.git',
  ];
  if (remote.status !== 0 || !allowedRemotes.includes(remote.stdout.trim()))
    throw new Error('Trusted origin must be DanielssonThomas/Stellar.');

  const localDevelop = spawnSync('git', ['rev-parse', 'origin/develop'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  const remoteDevelop = spawnSync(
    'git',
    ['ls-remote', 'origin', 'refs/heads/develop'],
    { cwd: repositoryRoot, encoding: 'utf8', windowsHide: true },
  );
  const localSha = localDevelop.stdout?.trim() ?? '';
  const remoteSha = (remoteDevelop.stdout ?? '').trim().split(/\s+/)[0];
  const localHead = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  const policyWorktree = spawnSync(
    'git',
    [
      'status',
      '--porcelain',
      '--untracked-files=all',
      '--',
      '.github/CODEOWNERS',
      'tools/policy',
    ],
    { cwd: repositoryRoot, encoding: 'utf8', windowsHide: true },
  );
  if (
    localDevelop.status !== 0 ||
    remoteDevelop.status !== 0 ||
    !/^[a-f0-9]{40}$/i.test(remoteSha) ||
    localSha !== remoteSha ||
    localHead.status !== 0 ||
    localHead.stdout?.trim() !== remoteSha ||
    policyWorktree.status !== 0 ||
    policyWorktree.stdout?.trim()
  )
    throw new Error(
      'Run Peon only from a clean trusted checkout at current origin/develop.',
    );

  const result = spawnSync(
    'git',
    ['show', 'origin/develop:.github/CODEOWNERS'],
    { cwd: repositoryRoot, encoding: 'utf8', windowsHide: true },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error('Could not load protected paths from origin/develop.');
  const policy = parseProtectedCodeowners(result.stdout);
  if (!policy.valid)
    throw new Error('origin/develop CODEOWNERS policy is invalid.');
  const protectedPaths = policy.patterns.map(({ path: entry, directory }) =>
    directory ? entry.replace(/\/+$/, '') : entry,
  );
  const protectedWorktree = spawnSync(
    'git',
    ['status', '--porcelain', '--untracked-files=all', '--', ...protectedPaths],
    { cwd: repositoryRoot, encoding: 'utf8', windowsHide: true },
  );
  if (protectedWorktree.status !== 0 || protectedWorktree.stdout?.trim())
    throw new Error(
      'Trusted protected files must be clean before starting Peon.',
    );
  return protectedPaths;
}

function validateProtectedMountSources(workspace, protectedPaths) {
  for (const entry of protectedPaths) {
    const source = path.posix.join(workspace, entry);
    const canonical = wslWorker('realpath', '-e', source);
    if (canonical !== source)
      throw new Error(
        `Protected path must not resolve through a symlink: ${entry}`,
      );
  }
}

function validateWorkspace(issueNumber, expectedBranchPrefix) {
  const workspace = issueWorkspace(issueNumber);
  const canonical = wslWorker('realpath', '-e', workspace);
  if (canonical !== workspace)
    throw new Error('Worker workspace must not resolve through a symlink.');

  const workerUid = positiveInteger(wslWorker('id', '-u'), 'worker uid');
  const workerGid = positiveInteger(wslWorker('id', '-g'), 'worker gid');
  const ownerUid = positiveInteger(
    wslWorker('stat', '-c', '%u', '--', workspace),
    'workspace owner uid',
  );
  if (ownerUid !== workerUid)
    throw new Error('Worker workspace must be owned by the peon account.');

  const root = wslWorker(
    'git',
    '-C',
    workspace,
    'rev-parse',
    '--show-toplevel',
  );
  if (root !== workspace)
    throw new Error('Worker workspace must be a standalone Git checkout.');
  const gitDirectory = wslWorker(
    'git',
    '-C',
    workspace,
    'rev-parse',
    '--absolute-git-dir',
  );
  const relativeGitDirectory = path.posix.relative(workspace, gitDirectory);
  if (
    !relativeGitDirectory ||
    relativeGitDirectory === '..' ||
    relativeGitDirectory.startsWith(`..${path.posix.sep}`) ||
    path.posix.isAbsolute(relativeGitDirectory)
  )
    throw new Error(
      'Worker Git metadata must stay inside its issue workspace.',
    );

  const branch = wslWorker('git', '-C', workspace, 'branch', '--show-current');
  if (!branch.startsWith(expectedBranchPrefix))
    throw new Error(`Worker branch must begin with ${expectedBranchPrefix}.`);

  return { workspace, workerUid, workerGid };
}

export function buildRestrictedVerificationArgs({
  issueNumber,
  image,
  uid,
  gid,
  command,
  protectedPaths,
  attemptNumber = 1,
}) {
  const number = positiveInteger(issueNumber, 'issueNumber');
  if (typeof image !== 'string' || !imagePattern.test(image))
    throw new Error(
      `Verification image must be ${workerImageRepository} pinned by a lowercase sha256 digest.`,
    );
  const userId = positiveInteger(uid, 'worker uid');
  const groupId = positiveInteger(gid, 'worker gid');
  positiveInteger(attemptNumber, 'attemptNumber');
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    command.some(
      (argument) => typeof argument !== 'string' || argument.includes('\0'),
    )
  )
    throw new Error(
      'A nonempty verification command argument list is required.',
    );
  if (
    !Array.isArray(protectedPaths) ||
    protectedPaths.length === 0 ||
    protectedPaths.some(
      (entry) =>
        typeof entry !== 'string' ||
        !entry ||
        entry.startsWith('/') ||
        /[\\,:=]/.test(entry) ||
        entry.split('/').some((part) => !part || part === '.' || part === '..'),
    )
  )
    throw new Error(
      'Trusted protected paths are required for verification mounts.',
    );

  const workspace = issueWorkspace(number);
  return [
    'run',
    '--rm',
    '--init',
    '--pull=never',
    `--name=stellar-peon-verify-${number}-${positiveInteger(attemptNumber, 'attemptNumber')}`,
    '--userns=keep-id',
    `--user=${userId}:${groupId}`,
    '--network=none',
    '--http-proxy=false',
    '--read-only',
    '--cap-drop=all',
    '--security-opt=no-new-privileges',
    '--pids-limit=128',
    '--memory=4g',
    '--memory-swap=4g',
    '--cpus=2',
    '--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=512m',
    `--mount=type=bind,src=${workspace},dst=/workspace,rw`,
    ...protectedPaths.map(
      (entry) =>
        `--mount=type=bind,src=${path.posix.join(workspace, entry)},dst=/workspace/${entry},ro`,
    ),
    '--workdir=/workspace',
    '--env=HOME=/tmp',
    '--env=COREPACK_HOME=/opt/corepack',
    '--env=COREPACK_DEFAULT_TO_LATEST=0',
    '--env=COREPACK_ENABLE_NETWORK=0',
    '--env=NX_SKIP_NATIVE_FILE_CACHE=true',
    '--env=HERMES_RUNTIME_DIR=/opt/hermes/tools',
    '--env=TMPDIR=/tmp',
    image,
    ...command,
  ];
}

export function parseArguments(argv) {
  const separator = argv.indexOf('--');
  if (separator < 0)
    throw new Error(
      'Usage: run-restricted-worker.mjs --issue <number> --image <repo@sha256:digest> -- <command> [args...]',
    );
  const options = {};
  for (let index = 0; index < separator; index += 1) {
    const key = argv[index];
    if (!['--issue', '--image'].includes(key) || !argv[index + 1])
      throw new Error(`Unknown or incomplete option: ${key}`);
    if (Object.hasOwn(options, key))
      throw new Error(`Option may only be provided once: ${key}`);
    options[key] = argv[index + 1];
    index += 1;
  }
  if (!options['--issue'] || !options['--image'])
    throw new Error('Both --issue and --image are required.');
  const command = argv.slice(separator + 1);
  if (command.length === 0) throw new Error('Worker command is required.');
  return {
    issueNumber: positiveInteger(options['--issue'], 'issue'),
    image: options['--image'],
    command,
  };
}

export async function runRestrictedWorker({
  issueNumber,
  image,
  command,
  limits = defaultLimits,
  initialUsage = {},
  attemptNumber = 1,
  verifyImageCompatibility = verifyPinnedWorkerImageCompatibility,
  lifecycle = {},
}) {
  const number = positiveInteger(issueNumber, 'issueNumber');
  const expectedBranchPrefix = `issue/${number}-`;
  const { workerUid, workerGid } = validateWorkspace(
    number,
    expectedBranchPrefix,
  );
  const protectedPaths = loadProtectedPaths();
  validateProtectedMountSources(issueWorkspace(number), protectedPaths);
  const imagePresent = spawnSync(
    'wsl.exe',
    [
      '--distribution',
      distribution,
      '--user',
      workerAccount,
      '--exec',
      'podman',
      'image',
      'exists',
      image,
    ],
    { cwd: repositoryRoot, windowsHide: true, timeout: 15000 },
  );
  if (imagePresent.error) throw imagePresent.error;
  if (imagePresent.status !== 0)
    throw new Error(
      "Pinned worker image is not present in peon's local Podman store.",
    );
  await verifyImageCompatibility({ image });
  assertAttemptNotCancelled(lifecycle);

  const secret = wslWorker('podman', 'secret', 'inspect', workerSecret);
  if (!secret) throw new Error('Worker GitHub token secret is unavailable.');
  const modelNetworks = JSON.parse(
    wslWorker('podman', 'network', 'inspect', modelNetwork),
  );
  if (modelNetworks.length !== 1 || modelNetworks[0].internal !== true)
    throw new Error('Peon model network must exist and be internal-only.');
  const workerNetworks = JSON.parse(
    wslWorker('podman', 'network', 'inspect', workerNetwork),
  );
  if (workerNetworks.length !== 1 || workerNetworks[0].internal !== true)
    throw new Error('Peon worker network must exist and be internal-only.');
  const egressNetworks = JSON.parse(
    wslWorker('podman', 'network', 'inspect', egressNetwork),
  );
  if (egressNetworks.length !== 1 || egressNetworks[0].internal !== false)
    throw new Error(
      'Peon egress network must exist and allow outbound access.',
    );

  const attempt = positiveInteger(attemptNumber, 'attemptNumber');
  const meterName = `stellar-peon-meter-${number}-${attempt}`;
  const workerName = `stellar-peon-worker-${number}-${attempt}`;
  const meterArgs = buildMeteringProxyArgs({
    name: meterName,
    image,
    uid: workerUid,
    gid: workerGid,
    maxModelTokens: limits.maxModelTokensPerWorker,
    maxToolCalls: limits.maxToolCallsPerWorker,
    initialModelTokens: initialUsage.modelTokens ?? 0,
    initialToolCalls: initialUsage.toolCalls ?? 0,
  });
  assertAttemptNotCancelled(lifecycle);
  let localCleanupDeadlineAt;
  const cleanupDeadlineAt = () => {
    localCleanupDeadlineAt ??= Date.now() + cancellationConfirmationTimeoutMs;
    return Math.min(
      localCleanupDeadlineAt,
      lifecycle.cancellationDeadlineAt ?? Number.POSITIVE_INFINITY,
    );
  };
  let result;
  let usage;
  let workerCleanup = { confirmed: false, state: 'inconclusive' };
  let meterCleanup = { confirmed: false, state: 'inconclusive' };
  try {
    wslWorker('podman', ...meterArgs);
    waitForMeter(meterName);
    assertAttemptNotCancelled(lifecycle);
    const workerArgs = buildPodmanArgs({
      issueNumber: number,
      image,
      uid: workerUid,
      gid: workerGid,
      command,
      protectedPaths,
      attemptNumber: attempt,
    });
    result = await new Promise((resolve, reject) => {
      const child = spawn(
        'wsl.exe',
        [
          '--distribution',
          distribution,
          '--user',
          workerAccount,
          '--exec',
          'podman',
          ...workerArgs,
        ],
        {
          cwd: repositoryRoot,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );
      const stdout = captureBoundedDiagnosticStream(child.stdout);
      const stderr = captureBoundedDiagnosticStream(child.stderr);
      child.once('error', reject);
      child.once('exit', (code, signal) =>
        resolve({
          code,
          signal,
          diagnostics: { stdout: stdout(), stderr: stderr() },
        }),
      );
    });
    workerCleanup = await stopRootlessContainer(workerName, {
      deadlineAt: cleanupDeadlineAt,
    });
    usage = readMeterUsage(meterName);
  } finally {
    meterCleanup = await stopRootlessContainer(meterName, {
      deadlineAt: cleanupDeadlineAt,
    });
  }
  if (!workerCleanup.confirmed)
    throw new Error('Could not confirm worker container termination.');
  if (!meterCleanup.confirmed)
    throw new Error('Could not confirm metering proxy shutdown.');
  return {
    exitCode: result.code ?? 1,
    signal: result.signal,
    usage,
    diagnostics: result.diagnostics,
    cleanup: {
      workerState: workerCleanup.state,
      meterState: meterCleanup.state,
    },
  };
}

const activeVerifications = new Map();

export async function runRestrictedVerification({
  issueNumber,
  image,
  command,
  attemptNumber = 1,
  containerOperations = createRootlessContainerOperations(),
  spawnProcess = spawn,
}) {
  const number = positiveInteger(issueNumber, 'issueNumber');
  const attempt = positiveInteger(attemptNumber, 'attemptNumber');
  const name = `stellar-peon-verify-${number}-${attempt}`;
  if (activeVerifications.has(name))
    throw new Error(
      'A verification container already uses this issue attempt.',
    );
  const { workspace, workerUid, workerGid } = validateWorkspace(
    number,
    `issue/${number}-`,
  );
  const protectedPaths = loadProtectedPaths();
  validateProtectedMountSources(workspace, protectedPaths);

  const args = buildRestrictedVerificationArgs({
    issueNumber: number,
    image,
    uid: workerUid,
    gid: workerGid,
    command,
    protectedPaths,
    attemptNumber: attempt,
  });
  wslWorker('podman', 'image', 'exists', image);
  const lifecycle = { cancellationDeadlineAt: null };
  let localCleanupDeadlineAt;
  const cleanupDeadlineAt = () => {
    localCleanupDeadlineAt ??= Date.now() + cancellationConfirmationTimeoutMs;
    return Math.min(
      localCleanupDeadlineAt,
      lifecycle.cancellationDeadlineAt ?? Number.POSITIVE_INFINITY,
    );
  };
  const child = spawnProcess(
    'wsl.exe',
    [
      '--distribution',
      distribution,
      '--user',
      workerAccount,
      '--exec',
      'podman',
      ...args,
    ],
    { cwd: repositoryRoot, stdio: 'ignore', windowsHide: true },
  );
  const processCompletion = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      resolve({ exitCode: code ?? 1, signal }),
    );
  });
  const finishVerification = async (result, processError) => {
    const cleanup = await stopRootlessContainer(name, {
      operations: containerOperations,
      deadlineAt: cleanupDeadlineAt,
    });
    if (!cleanup.confirmed)
      throw new Error('Could not confirm restricted verification termination.');
    if (processError) throw processError;
    return { ...result, cleanup };
  };
  const done = processCompletion.then(
    (result) => finishVerification(result),
    (error) => finishVerification(null, error),
  );
  const active = {
    done,
    settled: false,
    lifecycle,
    operations: containerOperations,
  };
  activeVerifications.set(name, active);
  done.then(
    () => {
      active.settled = true;
      if (activeVerifications.get(name) === active)
        activeVerifications.delete(name);
    },
    () => {
      active.settled = true;
      if (activeVerifications.get(name) === active)
        activeVerifications.delete(name);
    },
  );
  return done;
}

export async function cancelRestrictedVerification({
  issueNumber,
  attemptNumber,
  containerOperations = createRootlessContainerOperations(),
  now = Date.now,
  sleep,
}) {
  const name = `stellar-peon-verify-${positiveInteger(issueNumber, 'issueNumber')}-${positiveInteger(attemptNumber, 'attemptNumber')}`;
  const active = activeVerifications.get(name);
  const deadlineAt = now() + cancellationConfirmationTimeoutMs;
  if (active)
    active.lifecycle.cancellationDeadlineAt = Math.min(
      active.lifecycle.cancellationDeadlineAt ?? deadlineAt,
      deadlineAt,
    );
  const result = await confirmAttemptCleanup({
    workerName: name,
    completion: active?.done ?? Promise.resolve(),
    isCompletionSettled: () => active?.settled ?? true,
    operations: active?.operations ?? containerOperations,
    deadlineAt,
    now,
    ...(sleep ? { sleep } : {}),
  });
  return result.confirmed;
}

export function inspectRestrictedWorkspace(issueNumber, expectedBranch) {
  const number = positiveInteger(issueNumber, 'issueNumber');
  const workspace = issueWorkspace(number);
  const root = wslWorker(
    'git',
    '-C',
    workspace,
    'rev-parse',
    '--show-toplevel',
  );
  if (root !== workspace)
    throw new Error('Restricted worker workspace changed its repository root.');
  const branch = wslWorker('git', '-C', workspace, 'branch', '--show-current');
  if (branch !== expectedBranch)
    throw new Error('Restricted worker workspace branch changed unexpectedly.');
  const status = wslWorker(
    'git',
    '-C',
    workspace,
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
  );
  const diff = wslWorker('git', '-C', workspace, 'diff', '--binary', 'HEAD');
  const changes = status
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(3))
    .slice(0, 100);
  return {
    fingerprint: `${branch}\n${status}\n${diff}`,
    changes,
  };
}

export function buildHermesTaskCommand(task, limits = defaultLimits) {
  const issueNumber = positiveInteger(task?.issueNumber, 'task issueNumber');
  const runtimeSeconds = Math.ceil(
    positiveInteger(limits.maxRuntimeMsPerWorker, 'maxRuntimeMsPerWorker') /
      1000,
  );
  const prompt = [
    `You are Peon, a restricted coding worker assigned only to Stellar issue #${issueNumber}.`,
    `First retrieve the issue using the public GitHub API at https://api.github.com/repos/DanielssonThomas/Stellar/issues/${issueNumber}; inspect its title, body, labels, and current state before editing.`,
    'Read /workspace/AGENTS.md and /workspace/docs/guides/issue-workflow.md, then read the implement-issue skill and the relevant repository skill named by the issue.',
    'Confirm the issue owner, target, metadata, dependencies, and acceptance criteria. Stop and report a blocker if they do not authorize this assigned work.',
    'Work only in /workspace, which is the isolated issue worktree. Follow the issue plan and acceptance criteria, use repository generators and checks, and preserve truthful verification evidence.',
    `Create issue-linked conventional commits beginning with [#${issueNumber}], without emoji, and push only to the authorized worker fork branch. Do not write to upstream develop, open or merge a PR, or access the host/runtime; the trusted integration workflow handles PR creation.`,
    'Never print, copy, or include credentials in the issue, commit, or output.',
  ].join('\n\n');
  return [
    'hermes',
    'chat',
    '-Q',
    '--in',
    '/workspace',
    '--run-budget',
    String(runtimeSeconds),
    '-q',
    prompt,
  ];
}

export function createPeonWorkerAdapter({
  image,
  commandForTask = buildHermesTaskCommand,
  runAttempt = runRestrictedWorker,
  containerOperations = createRootlessContainerOperations(),
  now = Date.now,
  confirmCancellation = confirmAttemptCleanup,
}) {
  let active = null;
  let lastAttempt = null;
  return {
    id: 'peon',
    async run({ task, attemptNumber, limits, budget }) {
      const currentAttempt = positiveInteger(attemptNumber, 'attemptNumber');
      const current = {
        meterName: `stellar-peon-meter-${task.issueNumber}-${currentAttempt}`,
        workerName: `stellar-peon-worker-${task.issueNumber}-${currentAttempt}`,
        lifecycle: { cancellationDeadlineAt: null },
        settled: false,
        cancelPromise: null,
        done: null,
      };
      current.done = Promise.resolve().then(() =>
        runAttempt({
          issueNumber: task.issueNumber,
          image,
          command: commandForTask(task, limits),
          limits,
          initialUsage: budget.snapshot,
          attemptNumber: currentAttempt,
          lifecycle: current.lifecycle,
        }),
      );
      current.done.then(
        () => {
          current.settled = true;
        },
        () => {
          current.settled = true;
        },
      );
      active = current;
      lastAttempt = current;
      try {
        const result = await current.done;
        return result.exitCode === 0
          ? { status: 'completed', usage: result.usage }
          : {
              status: 'failed',
              usage: result.usage,
              failure: {
                code: 'WorkerExit',
                message: formatWorkerFailure(result),
              },
            };
      } finally {
        if (active === current) active = null;
      }
    },
    async usage() {
      if (!active) return { toolCalls: 0, modelTokens: 0 };
      return readMeterUsage(active.meterName);
    },
    cancel() {
      const current = active ?? lastAttempt;
      if (!current) return true;
      if (!current.cancelPromise) {
        const deadlineAt = now() + cancellationConfirmationTimeoutMs;
        current.lifecycle.cancellationDeadlineAt = Math.min(
          current.lifecycle.cancellationDeadlineAt ?? deadlineAt,
          deadlineAt,
        );
        current.cancelPromise = confirmCancellation({
          workerName: current.workerName,
          meterName: current.meterName,
          completion: current.done,
          isCompletionSettled: () => current.settled,
          operations: containerOperations,
          deadlineAt,
          now,
        }).then((result) => result === true || result?.confirmed === true);
      }
      return current.cancelPromise;
    },
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = await runRestrictedWorker(options);
  process.exitCode = result.exitCode;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
