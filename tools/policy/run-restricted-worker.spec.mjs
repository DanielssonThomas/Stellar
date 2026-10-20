import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildMeteringProxyArgs,
  buildPodmanArgs,
  parseArguments,
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
    '--env=HERMES_HOME=/tmp/.hermes',
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
