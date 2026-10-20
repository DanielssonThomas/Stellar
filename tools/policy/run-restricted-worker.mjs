import { spawnSync } from 'node:child_process';
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
const workerImageRepository = 'ghcr.io/stellar-ai-corp/hermes-worker';
const imagePattern =
  /^ghcr\.io\/stellar-ai-corp\/hermes-worker@sha256:[a-f0-9]{64}$/;

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

function issueWorkspace(issueNumber) {
  return path.posix.join(workspaceRoot, `issue-${issueNumber}`);
}

export function buildPodmanArgs({ issueNumber, image, uid, gid, command }) {
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
  return [
    'run',
    '--rm',
    '--init',
    '--pull=never',
    '--userns=keep-id',
    `--user=${userId}:${groupId}`,
    '--network=slirp4netns:allow_host_loopback=false',
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
    '--workdir=/workspace',
    '--env=HOME=/tmp',
    '--env=HERMES_HOME=/tmp/.hermes',
    '--env=TMPDIR=/tmp',
    `--secret=source=${workerSecret},type=env,target=GH_TOKEN`,
    image,
    ...command,
  ];
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

export function runRestrictedWorker({ issueNumber, image, command }) {
  const number = positiveInteger(issueNumber, 'issueNumber');
  const expectedBranchPrefix = `issue/${number}-`;
  const { workerUid, workerGid } = validateWorkspace(
    number,
    expectedBranchPrefix,
  );
  const secret = wslWorker('podman', 'secret', 'inspect', workerSecret);
  if (!secret) throw new Error('Worker GitHub token secret is unavailable.');
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

  const podmanArgs = buildPodmanArgs({
    issueNumber: number,
    image,
    uid: workerUid,
    gid: workerGid,
    command,
  });
  const result = spawnSync(
    'wsl.exe',
    [
      '--distribution',
      distribution,
      '--user',
      workerAccount,
      '--exec',
      'podman',
      ...podmanArgs,
    ],
    { cwd: repositoryRoot, stdio: 'inherit', windowsHide: true },
  );
  if (result.error) throw result.error;
  return result.status ?? 1;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const exitCode = runRestrictedWorker(options);
  process.exitCode = exitCode;
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
