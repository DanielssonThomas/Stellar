import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import {
  buildMeteringProxyArgs,
  buildPodmanArgs,
  buildRestrictedVerificationArgs,
  buildHermesTaskCommand,
  captureBoundedDiagnosticStream,
  formatWorkerFailure,
  parseArguments,
  redactWorkerDiagnostics,
} from './run-restricted-worker.mjs';

const image = `ghcr.io/stellar-ai-corp/hermes-worker@sha256:${'a'.repeat(64)}`;
const protectedPaths = [
  '.agents/skills',
  '.github/CODEOWNERS',
  '.github/workflows',
  '.husky',
  'AGENTS.md',
  'commitlint.config.cjs',
  'docs/documentation-policy.md',
  'docs/guides/agent-supervision.md',
  'docs/guides/worker-integration-policy.md',
  'docs/guides/worker-security.md',
  'eslint.config.mjs',
  'nx.json',
  'tools/generators',
  'tools/policy',
];

test('builds a rootless, resource-bounded Podman invocation for one issue clone', () => {
  const args = buildPodmanArgs({
    issueNumber: 21,
    image,
    uid: 1001,
    gid: 1001,
    protectedPaths,
    command: ['hermes', '--issue', '21'],
  });

  assert.deepEqual(args, [
    'run',
    '--rm',
    '--init',
    '--pull=never',
    '--name=stellar-peon-worker-21-1',
    '--userns=keep-id',
    '--user=1001:1001',
    '--network=stellar-peon-worker',
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
    '--mount=type=bind,src=/home/peon/workspaces/issue-21,dst=/workspace,rw',
    '--mount=type=bind,src=/home/peon/workspaces/issue-21/tools/policy/peon-hermes-config.yaml,dst=/tmp/.hermes/config.yaml,ro',
    '--mount=type=bind,src=/home/peon/workspaces/issue-21/.agents/skills,dst=/workspace/.agents/skills,ro',
    '--mount=type=bind,src=/home/peon/workspaces/issue-21/.github/CODEOWNERS,dst=/workspace/.github/CODEOWNERS,ro',
    '--mount=type=bind,src=/home/peon/workspaces/issue-21/.github/workflows,dst=/workspace/.github/workflows,ro',
    '--mount=type=bind,src=/home/peon/workspaces/issue-21/.husky,dst=/workspace/.husky,ro',
    '--mount=type=bind,src=/home/peon/workspaces/issue-21/AGENTS.md,dst=/workspace/AGENTS.md,ro',
    '--mount=type=bind,src=/home/peon/workspaces/issue-21/commitlint.config.cjs,dst=/workspace/commitlint.config.cjs,ro',
    '--mount=type=bind,src=/home/peon/workspaces/issue-21/docs/documentation-policy.md,dst=/workspace/docs/documentation-policy.md,ro',
    '--mount=type=bind,src=/home/peon/workspaces/issue-21/docs/guides/agent-supervision.md,dst=/workspace/docs/guides/agent-supervision.md,ro',
    '--mount=type=bind,src=/home/peon/workspaces/issue-21/docs/guides/worker-integration-policy.md,dst=/workspace/docs/guides/worker-integration-policy.md,ro',
    '--mount=type=bind,src=/home/peon/workspaces/issue-21/docs/guides/worker-security.md,dst=/workspace/docs/guides/worker-security.md,ro',
    '--mount=type=bind,src=/home/peon/workspaces/issue-21/eslint.config.mjs,dst=/workspace/eslint.config.mjs,ro',
    '--mount=type=bind,src=/home/peon/workspaces/issue-21/nx.json,dst=/workspace/nx.json,ro',
    '--mount=type=bind,src=/home/peon/workspaces/issue-21/tools/generators,dst=/workspace/tools/generators,ro',
    '--mount=type=bind,src=/home/peon/workspaces/issue-21/tools/policy,dst=/workspace/tools/policy,ro',
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
    '--secret=source=stellar-worker-github-token,type=env,target=GH_TOKEN',
    image,
    'hermes',
    '--issue',
    '21',
  ]);
  assert.equal(
    args.some((argument) => argument === '--privileged'),
    false,
  );
  assert.equal(
    args.some((argument) => argument.includes('podman.sock')),
    false,
  );
  assert.equal(
    args.some((argument) => argument.includes('/mnt/')),
    false,
  );
  assert.equal(args.includes('--network=stellar-peon-model'), false);
  assert.equal(args.includes('--network=stellar-peon-egress'), false);
});

test('builds a separate hardened metering proxy on the worker, model, and egress networks', () => {
  const args = buildMeteringProxyArgs({
    name: 'stellar-peon-meter-24-1',
    image,
    uid: 1001,
    gid: 1001,
    maxModelTokens: 32_000,
    maxToolCalls: 64,
  });
  assert.equal(
    args.includes('--network=stellar-peon-worker:alias=peon-meter'),
    true,
  );
  assert.equal(args.includes('--network=stellar-peon-model'), true);
  assert.equal(args.includes('--network=stellar-peon-egress'), true);
  assert.ok(
    args.indexOf('--network=stellar-peon-egress') <
      args.indexOf('--network=stellar-peon-worker:alias=peon-meter'),
  );
  assert.equal(args.includes('--privileged'), false);
  assert.equal(
    args.includes(
      '--secret=source=stellar-worker-github-token,type=env,target=GH_TOKEN',
    ),
    false,
  );
  assert.throws(
    () =>
      buildMeteringProxyArgs({
        name: 'wrong',
        image,
        uid: 1001,
        gid: 1001,
        maxModelTokens: 32_000,
        maxToolCalls: 64,
      }),
    /identify one issue attempt/,
  );
  assert.throws(
    () =>
      buildMeteringProxyArgs({
        name: 'stellar-peon-meter-24-1',
        image,
        uid: 1001,
        gid: 1001,
        maxModelTokens: 64_001,
        maxToolCalls: 64,
      }),
    /hard limits/,
  );
});

test('runs trusted checks in an isolated container without worker or integration credentials', () => {
  const args = buildRestrictedVerificationArgs({
    issueNumber: 50,
    image,
    uid: 1001,
    gid: 1001,
    command: ['corepack', 'pnpm', 'exec', 'nx', 'test', 'ui-atoms'],
    protectedPaths,
    attemptNumber: 1,
  });

  assert.ok(args.includes('--network=none'));
  assert.ok(args.includes('--read-only'));
  assert.ok(args.includes('--env=COREPACK_HOME=/opt/corepack'));
  assert.ok(args.includes('--env=COREPACK_ENABLE_NETWORK=0'));
  assert.ok(args.includes('--env=HERMES_RUNTIME_DIR=/opt/hermes/tools'));
  assert.ok(args.includes('--env=NX_SKIP_NATIVE_FILE_CACHE=true'));
  assert.ok(args.includes('--cap-drop=all'));
  assert.ok(
    args.includes(
      '--mount=type=bind,src=/home/peon/workspaces/issue-50/tools/policy,dst=/workspace/tools/policy,ro',
    ),
  );
  assert.ok(
    args.includes(
      '--mount=type=bind,src=/home/peon/workspaces/issue-50,dst=/workspace,rw',
    ),
  );
  assert.equal(
    args.some((argument) => argument.includes('GH_TOKEN')),
    false,
  );
  assert.equal(
    args.some((argument) => argument.includes('STELLAR_INTEGRATION_TOKEN')),
    false,
  );
  assert.equal(
    args.some((argument) => argument.startsWith('--secret=')),
    false,
  );
  assert.equal(
    args.some((argument) => argument.includes('peon-meter')),
    false,
  );
  assert.throws(
    () =>
      buildRestrictedVerificationArgs({
        issueNumber: 50,
        image,
        uid: 1001,
        gid: 1001,
        command: [],
        protectedPaths,
      }),
    /nonempty verification command/,
  );
});

test('pins the offline package-manager cache outside the writable worker home', () => {
  const containerfile = readFileSync(
    new URL('../worker-image/Containerfile', import.meta.url),
    'utf8',
  );
  assert.match(containerfile, /COREPACK_HOME=\/opt\/corepack/);
  assert.match(containerfile, /COREPACK_DEFAULT_TO_LATEST=0/);
  assert.match(containerfile, /COREPACK_ENABLE_NETWORK=0/);
  assert.match(containerfile, /HERMES_RUNTIME_DIR=\/opt\/hermes\/tools/);
  assert.match(containerfile, /corepack prepare pnpm@10\.28\.2 --activate/);
});

test('repairs Hermes dependencies at build time and verifies immutable runtime activation', () => {
  const containerfile = readFileSync(
    new URL('../worker-image/Containerfile', import.meta.url),
    'utf8',
  );
  const verifier = readFileSync(
    new URL('../worker-image/verify-hermes-runtime.py', import.meta.url),
    'utf8',
  );
  assert.match(containerfile, /hermes pm repair/);
  assert.match(containerfile, /verify-hermes-runtime\.py/);
  assert.match(containerfile, /hermes skills list >\/dev\/null/);
  assert.match(containerfile, /\.prepare\.lock/);
  assert.match(containerfile, /\/tmp\/hermes-prepare\.lock/);
  assert.match(containerfile, /packages.*venv.*environment/s);
  assert.match(containerfile, /selected\.json/);
  assert.match(containerfile, /\/tmp\/\.hermes\/skills/);
  assert.doesNotMatch(
    containerfile,
    /ln -s \/opt\/hermes\/skills \/tmp\/\.hermes\/skills/,
  );
  assert.doesNotMatch(containerfile, /environment_dir=.*find.*\/environments/s);
  assert.match(verifier, /activate_dependencies\(PROJECT_ROOT\)/);
  assert.match(verifier, /pm-runtime\.json/);
  assert.match(verifier, /hermes_cli\.main/);
  assert.match(verifier, /environment\.parent \/ ".leases"/);
  assert.match(verifier, /generation \/ ".leases"/);
});

test('rejects image tags without an immutable digest', () => {
  assert.throws(
    () =>
      buildPodmanArgs({
        issueNumber: 21,
        image: 'ghcr.io/stellar-ai-corp/hermes-worker:latest',
        uid: 1001,
        gid: 1001,
        protectedPaths,
        command: ['hermes'],
      }),
    /pinned by a lowercase sha256 digest/,
  );
  assert.throws(
    () =>
      buildPodmanArgs({
        issueNumber: 21,
        image: `docker.io/library/alpine@sha256:${'a'.repeat(64)}`,
        uid: 1001,
        gid: 1001,
        protectedPaths,
        command: ['hermes'],
      }),
    /ghcr\.io\/stellar-ai-corp\/hermes-worker/,
  );
});

test('rejects invalid issue identifiers and empty commands', () => {
  assert.throws(
    () =>
      buildPodmanArgs({
        issueNumber: '../21',
        image,
        uid: 1001,
        gid: 1001,
        protectedPaths,
        command: ['hermes'],
      }),
    /issueNumber must be a positive integer/,
  );
  assert.throws(
    () =>
      buildPodmanArgs({
        issueNumber: 21,
        image,
        uid: 1001,
        gid: 1001,
        command: [],
      }),
    /nonempty command argument list/,
  );
});

test('parses one issue and pinned image before the command separator', () => {
  assert.deepEqual(
    parseArguments([
      '--issue',
      '21',
      '--image',
      image,
      '--',
      'hermes',
      '--issue',
      '21',
    ]),
    { issueNumber: 21, image, command: ['hermes', '--issue', '21'] },
  );
  assert.throws(
    () =>
      parseArguments([
        '--issue',
        '21',
        '--issue',
        '22',
        '--image',
        image,
        '--',
        'hermes',
      ]),
    /may only be provided once/,
  );
});

test('fails closed when trusted protected paths are missing or unsafe', () => {
  const base = {
    issueNumber: 21,
    image,
    uid: 1001,
    gid: 1001,
    command: ['hermes'],
  };
  assert.throws(() => buildPodmanArgs(base), /Trusted protected paths/);
  assert.throws(
    () => buildPodmanArgs({ ...base, protectedPaths: ['../tools/policy'] }),
    /Trusted protected paths/,
  );
  assert.throws(
    () => buildPodmanArgs({ ...base, protectedPaths: ['/tools/policy'] }),
    /Trusted protected paths/,
  );
});

test('builds a supported bounded Hermes chat command with issue retrieval guidance', () => {
  const command = buildHermesTaskCommand(
    { issueNumber: 48 },
    { maxRuntimeMsPerWorker: 125_000 },
  );
  assert.deepEqual(command.slice(0, 8), [
    'hermes',
    'chat',
    '-Q',
    '--in',
    '/workspace',
    '--run-budget',
    '125',
    '-q',
  ]);
  assert.match(
    command[8],
    /api\.github\.com\/repos\/DanielssonThomas\/Stellar\/issues\/48/,
  );
  assert.match(command[8], /AGENTS\.md/);
  assert.match(command[8], /implement-issue skill/);
  assert.match(command[8], /worker fork branch/);
  assert.doesNotMatch(command[8], /GH_TOKEN|STELLAR_INTEGRATION_TOKEN/);
  assert.throws(
    () =>
      buildHermesTaskCommand({ issueNumber: 48 }, { maxRuntimeMsPerWorker: 0 }),
    /maxRuntimeMsPerWorker/,
  );
});

test('passes the complete Hermes executable command through the pinned image entrypoint', () => {
  const command = buildHermesTaskCommand(
    { issueNumber: 50 },
    { maxRuntimeMsPerWorker: 600_000 },
  );
  const args = buildPodmanArgs({
    issueNumber: 50,
    image,
    uid: 1001,
    gid: 1001,
    protectedPaths,
    command,
  });
  const imagePosition = args.indexOf(image);
  const containerfile = readFileSync(
    new URL('../worker-image/Containerfile', import.meta.url),
    'utf8',
  );

  assert.ok(imagePosition >= 0);
  assert.deepEqual(args.slice(imagePosition + 1), command);
  assert.deepEqual(args.slice(imagePosition + 1, imagePosition + 5), [
    'hermes',
    'chat',
    '-Q',
    '--in',
  ]);
  assert.match(
    containerfile,
    /ENTRYPOINT \["\/usr\/local\/libexec\/hermes-worker-entrypoint"\]/,
  );
  assert.match(containerfile, /'exec "\$@"'/);
});

test('captures bounded diagnostics and redacts credentials, headers, and secret assignments', () => {
  const stream = new PassThrough();
  const read = captureBoundedDiagnosticStream(stream);
  stream.write('startup diagnostic '.repeat(700));
  stream.end();
  const bounded = read();

  assert.equal(bounded.truncated, true);
  assert.ok(Buffer.byteLength(bounded.text) <= 8 * 1024);

  const redacted = redactWorkerDiagnostics(
    [
      'GH_TOKEN=ghp_123456789012345678901234567890123456',
      'Authorization: Bearer private-auth-value',
      'OPENAI_API_KEY=private-api-value',
      'unexpected opaque value 12345678901234567890',
    ].join('\n'),
  );
  assert.doesNotMatch(redacted, /ghp_1234567890|private-auth-value/);
  assert.doesNotMatch(redacted, /private-api-value|12345678901234567890/);
  assert.match(redacted, /\[REDACTED\]/);

  const failure = formatWorkerFailure({
    exitCode: 127,
    diagnostics: {
      stderr: { text: 'exec: chat: not found', truncated: false },
      stdout: {
        text: 'Authorization: Bearer private-auth-value',
        truncated: false,
      },
    },
  });
  assert.match(failure, /status 127/);
  assert.match(failure, /exec: chat: not found/);
  assert.doesNotMatch(failure, /private-auth-value/);
});

test('configures the exact pinned Hermes turn-limit key', () => {
  const config = readFileSync(
    new URL('./peon-hermes-config.yaml', import.meta.url),
    'utf8',
  );
  assert.match(config, /agent:\s+coding_context:\s+focus\s+max_turns:\s+250/);
  assert.doesNotMatch(config, /max_iterations/);
});
