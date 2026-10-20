import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPodmanArgs, parseArguments } from './run-restricted-worker.mjs';

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
    '--userns=keep-id',
    '--user=1001:1001',
    '--network=stellar-peon-egress',
    '--network=stellar-peon-model',
    '--http-proxy=false',
    '--read-only',
    '--cap-drop=all',
    '--security-opt=no-new-privileges',
    '--pids-limit=128',
    '--memory=4g',
    '--memory-swap=4g',
    '--cpus=2',
    '--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=512m',
    '--mount=type=bind,src=/home/peon/workspaces/issue-21,dst=/workspace,rw',
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
  assert.equal(args.includes('--network=stellar-peon-model'), true);
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
