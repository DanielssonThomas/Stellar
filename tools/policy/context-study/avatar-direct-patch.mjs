import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildMeteringProxyArgs,
  verifyPinnedWorkerImageCompatibility,
} from '../run-restricted-worker.mjs';
import { trustedPeonWorkerImage } from '../supervised-peon-run.mjs';
import {
  cancellationConfirmationTimeoutMs,
  stopAndConfirmAttemptContainers,
} from '../worker-container-lifecycle.mjs';
import {
  avatarPrompt,
  avatarSource,
  avatarTest,
  validateAvatarPatch,
  validateAvatarResult,
  validateUsage,
} from './avatar-patch-core.mjs';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);
const stateRoot = path.resolve(root, '..', '.stellar-supervisor-state');
const clientPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'avatar-patch-client.mjs',
);
const modelName = 'stellar-peon-qwen';
const workerName = 'stellar-peon-worker-50-1001';
const meterName = 'stellar-peon-meter-50-1001';
const modelImage =
  'ghcr.io/ggml-org/llama.cpp@sha256:c65f01343624f55848a82a6b653880e53399377a92b371975eb3303c1d5647e7';
const childEnv = () => ({
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  WINDIR: process.env.WINDIR,
  TEMP: process.env.TEMP,
  TMP: process.env.TMP,
  WSLENV: '',
});

export function clientContainerArgs(scriptSource) {
  if (
    !/^\/mnt\/[a-z]\/[^,:\\]+\/tools\/policy\/context-study\/avatar-patch-client\.mjs$/.test(
      scriptSource,
    )
  )
    throw new Error('isolation: invalid trusted client path');
  return [
    'run',
    '--rm',
    '--init',
    '--pull=never',
    '--interactive',
    `--name=${workerName}`,
    '--userns=keep-id',
    '--user=1001:1001',
    '--network=stellar-peon-worker',
    '--network=stellar-peon-model',
    '--http-proxy=false',
    '--read-only',
    '--cap-drop=all',
    '--security-opt=no-new-privileges',
    '--pids-limit=64',
    '--memory=512m',
    '--memory-swap=512m',
    '--cpus=1',
    '--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=64m',
    `--mount=type=bind,src=${scriptSource},dst=/opt/avatar-patch-client.mjs,ro`,
    '--entrypoint=node',
    trustedPeonWorkerImage,
    '/opt/avatar-patch-client.mjs',
  ];
}

export function meterContainerArgs() {
  return buildMeteringProxyArgs({
    name: meterName,
    image: trustedPeonWorkerImage,
    uid: 1001,
    gid: 1001,
    maxModelTokens: 3_000,
    maxToolCalls: 1,
    maxForwardedRequests: 1,
  }).filter((arg) => arg !== '--network=stellar-peon-egress');
}

function command(
  file,
  args,
  {
    cwd = root,
    input,
    timeout = 10_000,
    maxBuffer = 64_000,
    reportOutput = false,
  } = {},
) {
  const result = spawnSync(file, args, {
    cwd,
    input,
    encoding: 'utf8',
    timeout,
    maxBuffer,
    windowsHide: true,
    env: childEnv(),
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `runtime: ${file} failed (${result.status ?? 'timeout'})${reportOutput ? `: ${`${result.stdout}\n${result.stderr}`.slice(-2_000)}` : ''}`,
    );
  return result.stdout.trimEnd();
}

function git(args, options) {
  return command('git', args, options);
}
function podman(args, options) {
  return command(
    'wsl.exe',
    ['--distribution', 'Ubuntu', '--user', 'peon', '--exec', 'podman', ...args],
    options,
  );
}

export function runBoundedPodman(
  args,
  {
    input,
    timeout,
    maxBuffer = 32_000,
    signal,
    reportOutput = false,
    spawnProcess = spawn,
  },
) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('interrupted: before launch'));
    const child = spawnProcess(
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
        cwd: root,
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: childEnv(),
      },
    );
    let settled = false;
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(stdout.trimEnd());
    };
    const onAbort = () => {
      finish(new Error('interrupted: running container command'));
      child.kill();
    };
    child.stdout?.on('data', (part) => {
      stdoutBytes += part.length;
      if (stdoutBytes <= maxBuffer) stdout += part.toString('utf8');
      else {
        finish(new Error('format: container output exceeds limit'));
        child.kill();
      }
    });
    child.stderr?.on('data', (part) => {
      if (reportOutput) stderr = (stderr + part.toString('utf8')).slice(-2_000);
    });
    child.once('error', () =>
      finish(new Error('runtime: container command failed')),
    );
    child.once('close', (code) =>
      finish(
        code === 0
          ? null
          : new Error(
              `runtime: container command exited ${code ?? 'unknown'}${reportOutput ? `: ${`${stdout}\n${stderr}`.slice(-2_000)}` : ''}`,
            ),
      ),
    );
    const timer = setTimeout(
      () => {
        finish(new Error('runtime: container command timed out'));
        child.kill();
      },
      Math.max(1, timeout),
    );
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdin?.on('error', () =>
      finish(new Error('runtime: container input pipe failed')),
    );
    if (input !== undefined) child.stdin?.end(input, 'utf8');
  });
}

function wslPath(file) {
  const resolved = path.resolve(file);
  const match = /^([A-Za-z]):\\(.+)$/.exec(resolved);
  if (!match || /[,:]/.test(match[2]))
    throw new Error('isolation: invalid WSL path');
  return `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll('\\', '/')}`;
}

function parseContainerState(raw, name) {
  const rows = JSON.parse(raw);
  if (!Array.isArray(rows) || rows.length > 1)
    throw new Error('cleanup: ambiguous container');
  if (!rows.length) return 'absent';
  const names = rows[0].Names;
  if (!Array.isArray(names) || names.length !== 1 || names[0] !== name)
    throw new Error('cleanup: container identity mismatch');
  const state = String(rows[0].State).toLowerCase();
  if (['exited', 'stopped'].includes(state)) return 'stopped';
  if (state === 'running') return 'running';
  throw new Error('cleanup: inconclusive container state');
}

function containerState(name, timeout = 10_000) {
  if (timeout <= 0) throw new Error('cleanup: deadline expired');
  return parseContainerState(
    podman(['ps', '--all', '--filter', `name=^${name}$`, '--format', 'json'], {
      timeout,
    }),
    name,
  );
}

function asyncContainerState(name, timeoutMs) {
  return new Promise((resolve) => {
    if (timeoutMs <= 0) return resolve('inconclusive');
    const child = spawn(
      'wsl.exe',
      [
        '--distribution',
        'Ubuntu',
        '--user',
        'peon',
        '--exec',
        'podman',
        'ps',
        '--all',
        '--filter',
        `name=^${name}$`,
        '--format',
        'json',
      ],
      {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
        env: childEnv(),
      },
    );
    let settled = false;
    let bytes = 0;
    let output = '';
    const finish = (state) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(state);
    };
    child.stdout?.on('data', (part) => {
      bytes += part.length;
      if (bytes <= 8_192) output += part.toString('utf8');
    });
    child.once('error', () => finish('inconclusive'));
    child.once('close', (code) => {
      if (code !== 0 || bytes > 8_192) return finish('inconclusive');
      try {
        finish(parseContainerState(output, name));
      } catch {
        finish('inconclusive');
      }
    });
    const timer = setTimeout(() => {
      child.kill();
      finish('inconclusive');
    }, timeoutMs);
  });
}

function networkIsInternal(name) {
  return (
    podman(['network', 'inspect', name, '--format', '{{.Internal}}']) === 'true'
  );
}

function assertPreflight(base) {
  if (!/^[a-f0-9]{40}$/.test(base))
    throw new Error('preflight: exact base SHA required');
  const remote = git(['ls-remote', 'origin', 'refs/heads/develop']).split(
    /\s+/,
  )[0];
  if (remote !== base) throw new Error('preflight: develop changed');
  git(['cat-file', '-e', `${base}^{commit}`]);
  git([
    'merge-base',
    '--is-ancestor',
    'c4b1fe88d27b3015b0993a3435dc89919a00bfbd',
    base,
  ]);
  if (
    !networkIsInternal('stellar-peon-model') ||
    !networkIsInternal('stellar-peon-worker')
  )
    throw new Error('isolation: internal networks missing');
  if (
    containerState(modelName) !== 'stopped' ||
    containerState(workerName) !== 'absent' ||
    containerState(meterName) !== 'absent'
  )
    throw new Error('preflight: benchmark containers not idle');
  const image = podman(['inspect', modelName, '--format', '{{.Config.Image}}']);
  if (image !== modelImage) throw new Error('isolation: model image changed');
  const networks = JSON.parse(
    podman([
      'inspect',
      modelName,
      '--format',
      '{{json .NetworkSettings.Networks}}',
    ]),
  );
  const mounts = JSON.parse(
    podman(['inspect', modelName, '--format', '{{json .Mounts}}']),
  );
  const env = JSON.parse(
    podman(['inspect', modelName, '--format', '{{json .Config.Env}}']),
  );
  const ports = JSON.parse(
    podman([
      'inspect',
      modelName,
      '--format',
      '{{json .HostConfig.PortBindings}}',
    ]),
  );
  const limits = podman([
    'inspect',
    modelName,
    '--format',
    '{{.Config.User}} {{.HostConfig.Privileged}} {{.HostConfig.Memory}} {{.HostConfig.PidsLimit}}',
  ]).split(' ');
  if (
    Object.keys(networks).join() !== 'stellar-peon-model' ||
    (ports && Object.keys(ports).length) ||
    limits[0] !== '1001:1001' ||
    limits[1] !== 'false' ||
    Number(limits[2]) > 8 * 1024 ** 3 ||
    Number(limits[2]) <= 0 ||
    Number(limits[3]) > 128 ||
    Number(limits[3]) <= 0 ||
    !mounts.some(
      (mount) =>
        mount.Destination === '/models/Qwen3.5-4B-Q4_K_M.gguf' &&
        mount.RW === false,
    ) ||
    env.some((entry) => /^(?:GH_|GITHUB_|OPENAI_|ANTHROPIC_)/.test(entry))
  )
    throw new Error('isolation: model container configuration changed');
  podman(['image', 'exists', trustedPeonWorkerImage]);
  command('wsl.exe', [
    '--distribution',
    'Ubuntu',
    '--user',
    'peon',
    '--exec',
    'test',
    '-f',
    '/home/peon/workspaces/issue-50/node_modules/nx/bin/nx.js',
  ]);
}

export function makeDisposableCheckout(base, parent = stateRoot) {
  const directory = mkdtempSync(path.join(parent, 'avatar-direct-'));
  const checkout = path.join(directory, 'checkout');
  try {
    git(['worktree', 'add', '--detach', checkout, base]);
    if (
      git(['rev-parse', 'HEAD'], { cwd: checkout }) !== base ||
      git(['status', '--porcelain=v1'], { cwd: checkout }) !== '' ||
      existsSync(path.join(checkout, avatarTest))
    )
      throw new Error('workspace: checkout not clean or test already exists');
    return { directory, checkout };
  } catch (error) {
    if (existsSync(checkout)) {
      try {
        git(['worktree', 'remove', '--force', checkout]);
      } catch {
        throw new Error('cleanup: partial checkout could not be removed');
      }
    }
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

export function disposeCheckout({ directory, checkout }, parent = stateRoot) {
  const expected = path.resolve(parent);
  if (
    !path.resolve(directory).startsWith(`${expected}${path.sep}`) ||
    path.dirname(path.resolve(checkout)) !== path.resolve(directory)
  )
    throw new Error('cleanup: checkout outside disposable root');
  const modules = path.join(checkout, 'node_modules');
  if (existsSync(modules)) {
    const stat = lstatSync(modules);
    if (stat.isSymbolicLink()) rmSync(modules, { force: true });
    else if (stat.isDirectory() && readdirSync(modules).length === 0)
      rmdirSync(modules);
    else throw new Error('cleanup: dependency mount path contains files');
  }
  git(['worktree', 'remove', '--force', checkout]);
  if (existsSync(checkout)) throw new Error('cleanup: checkout remains');
  rmSync(directory, { recursive: true, force: true });
  if (existsSync(directory))
    throw new Error('cleanup: disposable directory remains');
}

function assertScopedFiles(checkout, testMayExist) {
  for (const file of [avatarSource, avatarTest]) {
    let current = checkout;
    const parts = file.split('/');
    for (const part of parts.slice(0, -1)) {
      current = path.join(current, part);
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error('scope: symlink or non-directory in allowed path');
    }
    const target = path.join(current, parts.at(-1));
    const stat = lstatSync(target, { throwIfNoEntry: false });
    if (stat) {
      if (file === avatarTest && !testMayExist)
        throw new Error('scope: focused test already exists');
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error('scope: symlink or non-file target');
    } else if (file === avatarSource || testMayExist) {
      throw new Error('scope: expected allowed file missing');
    }
  }
}

export function applyAndVerify(checkout, patch) {
  assertScopedFiles(checkout, false);
  validateAvatarPatch(patch);
  try {
    git(['apply', '--check', '--whitespace=error', '-'], {
      cwd: checkout,
      input: patch,
    });
    git(['apply', '--whitespace=error', '-'], { cwd: checkout, input: patch });
  } catch {
    throw new Error('format: patch does not apply');
  }
  const changed = git(['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: checkout,
  })
    .split('\n')
    .sort();
  if (
    changed.length !== 2 ||
    !changed.includes(` M ${avatarSource}`) ||
    !changed.includes(`?? ${avatarTest}`)
  )
    throw new Error(
      `scope: unexpected checkout changes (${changed.join(', ')})`,
    );
  assertScopedFiles(checkout, true);
  validateAvatarResult(
    readFileSync(path.join(checkout, avatarSource), 'utf8'),
    readFileSync(path.join(checkout, avatarTest), 'utf8'),
  );
}

export async function verifyUi(
  checkout,
  {
    onResult = () => undefined,
    checkpoint = async () => undefined,
    signal,
  } = {},
) {
  const specPath = path.join(checkout, avatarTest);
  const original = readFileSync(specPath, 'utf8');
  const results = [];
  let verifierCleanupConfirmed = true;
  try {
    appendFileSync(
      specPath,
      `\nimport { TestBed as BenchmarkTestBed } from '@angular/core/testing';\nimport { expect as benchmarkExpect, it as benchmarkIt } from 'vitest';\nimport { SkeletonAtom as BenchmarkSkeletonAtom } from './skeleton-atom.component';\nbenchmarkIt('trusted avatar acceptance', async () => {\n  await BenchmarkTestBed.configureTestingModule({ imports: [BenchmarkSkeletonAtom] }).compileComponents();\n  const fixture = BenchmarkTestBed.createComponent(BenchmarkSkeletonAtom);\n  const span = () => fixture.nativeElement.querySelector('span');\n  fixture.componentRef.setInput('shape', 'avatar');\n  await fixture.whenStable();\n  for (const cls of ['h-10', 'w-10', 'rounded-full', 'bg-stellar-skeleton']) benchmarkExpect(span().classList.contains(cls)).toBe(true);\n  benchmarkExpect(span().getAttribute('aria-hidden')).toBe('true');\n  fixture.componentRef.setInput('shape', 'text');\n  await fixture.whenStable();\n  for (const cls of ['h-4', 'w-24']) benchmarkExpect(span().classList.contains(cls)).toBe(true);\n  fixture.componentRef.setInput('shape', 'control');\n  await fixture.whenStable();\n  for (const cls of ['h-5', 'w-20']) benchmarkExpect(span().classList.contains(cls)).toBe(true);\n});\n`,
    );
    for (const target of ['lint', 'test', 'build']) {
      await checkpoint();
      let failure;
      try {
        await runBoundedPodman(
          verifierContainerArgs(wslPath(checkout), target),
          {
            timeout: 180_000,
            maxBuffer: 256_000,
            reportOutput: true,
            signal,
          },
        );
      } catch (error) {
        failure = new Error(
          `verification: ui-atoms ${target} failed: ${error.message}`,
        );
      }
      if (!confirmVerifierCleanup(target)) {
        verifierCleanupConfirmed = false;
        onResult(`${target}:cleanup-unconfirmed`);
        throw new Error(`cleanup: verifier ${target} not confirmed stopped`);
      }
      if (failure) {
        onResult(`${target}:failed`);
        throw failure;
      }
      results.push(`${target}:passed`);
      onResult(`${target}:passed`);
    }
    await checkpoint();
  } finally {
    if (verifierCleanupConfirmed) writeFileSync(specPath, original);
  }
  return results;
}

function confirmVerifierCleanup(target) {
  const name = `stellar-peon-verify-50-1001-${target}`;
  const deadlineAt = Date.now() + cancellationConfirmationTimeoutMs;
  const remaining = () => Math.max(0, deadlineAt - Date.now());
  try {
    if (containerState(name, remaining()) === 'running')
      podman(['stop', '--time', '1', name], { timeout: remaining() });
    if (remaining() <= 0) return false;
    return (
      ['absent', 'stopped'].includes(containerState(name, remaining())) &&
      remaining() > 0
    );
  } catch {
    return false;
  }
}

export function verifierContainerArgs(checkoutSource, target) {
  if (
    !['lint', 'test', 'build'].includes(target) ||
    !/^\/mnt\/[a-z]\/[^,:\\]+\/avatar-direct-[^/]+\/checkout$/.test(
      checkoutSource,
    )
  )
    throw new Error('isolation: invalid verifier target or checkout');
  return [
    'run',
    '--rm',
    '--init',
    '--pull=never',
    `--name=stellar-peon-verify-50-1001-${target}`,
    '--userns=keep-id',
    '--user=1001:1001',
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
    `--mount=type=bind,src=${checkoutSource},dst=/workspace,ro`,
    '--mount=type=bind,src=/home/peon/workspaces/issue-50/node_modules,dst=/workspace/node_modules,ro',
    '--tmpfs=/workspace/dist:rw,nosuid,nodev,size=512m,mode=1777',
    '--tmpfs=/workspace/tmp:rw,nosuid,nodev,size=512m,mode=1777',
    '--workdir=/workspace',
    '--env=HOME=/tmp',
    '--env=COREPACK_HOME=/opt/corepack',
    '--env=COREPACK_DEFAULT_TO_LATEST=0',
    '--env=COREPACK_ENABLE_NETWORK=0',
    '--env=NX_SKIP_NATIVE_FILE_CACHE=true',
    '--env=NX_DAEMON=false',
    '--env=NX_CACHE_DIRECTORY=/tmp/nx-cache',
    '--env=NX_WORKSPACE_DATA_DIRECTORY=/tmp/nx-workspace-data',
    trustedPeonWorkerImage,
    'corepack',
    'pnpm',
    'nx',
    target,
    'ui-atoms',
  ];
}

function asyncPodman(args, timeoutMs) {
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
      { stdio: 'ignore', windowsHide: true, env: childEnv() },
    );
    const timer = setTimeout(
      () => {
        child.kill();
        resolve(false);
      },
      Math.max(1, timeoutMs),
    );
    child.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

export async function confirmBenchmarkCleanup({
  stop = asyncPodman,
  inspect = asyncContainerState,
  deadlineAt = Date.now() + cancellationConfirmationTimeoutMs,
} = {}) {
  const remaining = () => Math.max(0, deadlineAt - Date.now());
  const attempt = stopAndConfirmAttemptContainers({
    workerName,
    meterName,
    deadlineAt,
    operations: {
      inspect: (name) => Promise.resolve(inspect(name, remaining())),
      stop: (name) => stop(['stop', '--time', '1', name], remaining()),
    },
  });
  const model = (async () => {
    await stop(['stop', '--time', '1', modelName], remaining());
    if (remaining() <= 0) return 'inconclusive';
    try {
      return await inspect(modelName, remaining());
    } catch {
      return 'inconclusive';
    }
  })();
  const [workerMeter, modelState] = await Promise.all([attempt, model]);
  const states = [workerMeter.workerState, workerMeter.meterState, modelState];
  return {
    confirmed:
      remaining() > 0 &&
      workerMeter.confirmed &&
      ['absent', 'stopped'].includes(modelState),
    states,
  };
}

async function waitForMeter(deadlineAt, signal) {
  while (Date.now() < deadlineAt) {
    try {
      await runBoundedPodman(
        [
          'exec',
          meterName,
          'node',
          '-e',
          'fetch("http://127.0.0.1:18436/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))',
        ],
        { timeout: Math.min(5_000, deadlineAt - Date.now()), signal },
      );
      return;
    } catch {
      if (signal?.aborted) throw new Error('interrupted: meter startup');
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error('runtime: meter/model health timeout');
}

function readMeterUsage() {
  const raw = podman(
    [
      'exec',
      meterName,
      'node',
      '-e',
      'fetch("http://127.0.0.1:18437/usage").then(r=>r.json()).then(x=>process.stdout.write(JSON.stringify(x)))',
    ],
    { timeout: 5_000 },
  );
  const usage = JSON.parse(raw);
  if (
    !Number.isSafeInteger(usage.forwardedRequests) ||
    !Number.isSafeInteger(usage.modelTokens) ||
    !Number.isSafeInteger(usage.toolCalls)
  )
    throw new Error('metering: invalid sidecar counters');
  return {
    forwardedRequests: usage.forwardedRequests,
    modelTokens: usage.modelTokens,
    toolCalls: usage.toolCalls,
    requestRecords: usage.requestRecords,
  };
}

export function reserveOneUseRun(base, parent = stateRoot) {
  mkdirSync(parent, { recursive: true });
  const lock = path.join(parent, 'avatar-direct-patch-once.lock');
  const fd = openSync(lock, 'wx');
  writeFileSync(fd, JSON.stringify({ base, runId: randomUUID() }));
  closeSync(fd);
  return lock;
}

export function installInterruptGuard(emitter = process) {
  let signal = null;
  const controller = new AbortController();
  const onInterrupt = () => {
    signal ??= 'SIGINT';
    controller.abort();
  };
  const onTerminate = () => {
    signal ??= 'SIGTERM';
    controller.abort();
  };
  emitter.on('SIGINT', onInterrupt);
  emitter.on('SIGTERM', onTerminate);
  return {
    signal: () => signal,
    abortSignal: controller.signal,
    async checkpoint() {
      await new Promise((resolve) => setImmediate(resolve));
      if (signal) throw new Error(`interrupted: ${signal}`);
    },
    dispose() {
      emitter.off('SIGINT', onInterrupt);
      emitter.off('SIGTERM', onTerminate);
    },
  };
}

export async function runAvatarBenchmark(base) {
  assertPreflight(base);
  await verifyPinnedWorkerImageCompatibility({
    image: trustedPeonWorkerImage,
    trustedRepositoryRoot: root,
  });
  reserveOneUseRun(base);
  const interrupt = installInterruptGuard();
  const result = {
    base,
    patchApplied: false,
    verification: [],
    cleanup: null,
    category: null,
  };
  let disposable;
  let startedContainers = false;
  const startedAt = Date.now();
  try {
    await interrupt.checkpoint();
    disposable = makeDisposableCheckout(base);
    const source = readFileSync(
      path.join(disposable.checkout, avatarSource),
      'utf8',
    );
    const example = readFileSync(
      path.join(
        disposable.checkout,
        'libs/ui/atoms/src/lib/atoms/button-atom.component.spec.ts',
      ),
      'utf8',
    );
    const prompt = avatarPrompt(source, example);
    try {
      startedContainers = true;
      podman(['start', modelName], { timeout: 10_000 });
      await interrupt.checkpoint();
      podman(meterContainerArgs(), { timeout: 10_000 });
      await interrupt.checkpoint();
      const deadlineAt = startedAt + 180_000;
      await waitForMeter(deadlineAt, interrupt.abortSignal);
      await interrupt.checkpoint();
      const raw = await runBoundedPodman(
        clientContainerArgs(wslPath(clientPath)),
        {
          input: JSON.stringify({ prompt }),
          timeout: Math.max(1, deadlineAt - Date.now()),
          maxBuffer: 32_000,
          signal: interrupt.abortSignal,
        },
      );
      await interrupt.checkpoint();
      const reply = JSON.parse(raw);
      result.usage = validateUsage(reply.usage);
      result.meter = readMeterUsage();
      if (
        result.meter.forwardedRequests !== 1 ||
        result.meter.modelTokens > 3_000 ||
        result.meter.toolCalls !== 0
      )
        throw new Error('metering: request or tool budget mismatch');
      if (
        !Number.isSafeInteger(reply.preflightPromptTokens) ||
        reply.preflightPromptTokens > 1_800 ||
        result.usage.prompt > 1_800
      )
        throw new Error('metering: prompt cap exceeded');
      result.patch = reply.patch;
      writeFileSync(
        path.join(stateRoot, 'avatar-direct-patch-once.diff'),
        reply.patch,
        { flag: 'wx' },
      );
    } finally {
      if (startedContainers && !result.meter) {
        try {
          result.meter = readMeterUsage();
        } catch {
          result.meter = { status: 'unavailable' };
        }
      }
      try {
        result.cleanup = startedContainers
          ? await confirmBenchmarkCleanup()
          : { confirmed: true, states: ['absent', 'absent', 'stopped'] };
      } catch {
        result.cleanup = { confirmed: false, states: ['inconclusive'] };
      }
      result.modelRuntimeMs = Date.now() - startedAt;
    }
    if (!result.cleanup.confirmed)
      throw new Error('cleanup: model containers not confirmed stopped');
    await interrupt.checkpoint();
    applyAndVerify(disposable.checkout, result.patch);
    result.patchApplied = true;
    await verifyUi(disposable.checkout, {
      onResult: (entry) => result.verification.push(entry),
      checkpoint: () => interrupt.checkpoint(),
      signal: interrupt.abortSignal,
    });
  } catch (error) {
    result.category = String(error.message).split(':')[0].slice(0, 40);
    if (interrupt.signal()) result.signal = interrupt.signal();
    if (result.category === 'cleanup' && result.cleanup)
      result.cleanup.confirmed = false;
  } finally {
    result.totalRuntimeMs = Date.now() - startedAt;
    result.cleanup ??= startedContainers
      ? { confirmed: false, states: ['inconclusive'] }
      : { confirmed: true, states: ['absent', 'absent', 'stopped'] };
    if (disposable && result.cleanup.confirmed) {
      try {
        disposeCheckout(disposable);
      } catch {
        result.cleanup.confirmed = false;
        result.category = 'cleanup';
      }
    }
    writeFileSync(
      path.join(stateRoot, 'avatar-direct-patch-once-result.json'),
      JSON.stringify(result, null, 2),
      { flag: 'wx' },
    );
    interrupt.dispose();
  }
  return result;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv.length !== 4 || process.argv[2] !== '--run')
    throw new Error(
      'Usage: node avatar-direct-patch.mjs --run <exact-develop-sha>',
    );
  const result = await runAvatarBenchmark(process.argv[3]);
  process.stdout.write(JSON.stringify({ ...result, patch: undefined }));
  if (
    result.category ||
    !result.cleanup?.confirmed ||
    !result.patchApplied ||
    result.verification.length !== 3
  )
    process.exitCode = 1;
}
