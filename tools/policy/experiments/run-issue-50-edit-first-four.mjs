// Single-use trusted host command. Requires separate authorization to execute.
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import {
  runSupervisedPeonIssue,
  trustedPeonWorkerImage,
} from '../supervised-peon-run.mjs';

const root = 'D:/ai-repositories/stellar';
const sessionId = 'peon-issue-50-edit-first-four-20261026-04';
const handoffPath =
  'D:/ai-repositories/.stellar-supervisor-state/issue-50-edit-first-four-20261026-04-handoff.json';
const windowsWorktree = 'D:/ai-repositories/stellar-issue-50';
const linuxWorktree = '/home/peon/workspaces/issue-50';
const historical = new Map([
  [
    'issue-50-bounded-20261026-02-handoff.json',
    '17eaaaa6c90e6f2000687fcdf175d6597a967a22e23a8bce17c68be6b851d27a',
  ],
  [
    'issue-50-pilot-20261026-handoff.json',
    '3576f7bc4c3e4bd55d5deb81482949edfa72e4eda1edc325a5f549953805f68e',
  ],
]);
const run = (program, args, cwd = root) =>
  execFileSync(program, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
const git = (...args) => run('git', args);
const wsl = (...args) =>
  run('wsl.exe', [
    '--distribution',
    'Ubuntu',
    '--user',
    'peon',
    '--exec',
    ...args,
  ]);

if (existsSync(handoffPath))
  throw new Error('This single-use handoff already exists.');
for (const [name, digest] of historical) {
  const bytes = readFileSync(
    `D:/ai-repositories/.stellar-supervisor-state/${name}`,
  );
  if (createHash('sha256').update(bytes).digest('hex') !== digest)
    throw new Error('Historical #50 handoff identity changed.');
}
if (
  git('status', '--porcelain') ||
  git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/develop')
)
  throw new Error('The trusted host must be clean at current develop.');
const issue = JSON.parse(
  run('gh', ['issue', 'view', '50', '--json', 'state,labels']),
);
const labels = issue.labels.map((entry) => entry.name);
if (
  issue.state !== 'OPEN' ||
  !labels.includes('status:ready') ||
  !labels.includes('worker:peon') ||
  !labels.includes('hermes-profile:narrow-evidence') ||
  !labels.includes('hermes-workflow:edit-first-4')
)
  throw new Error(
    'Issue #50 is not ready for the reviewed four-request experiment.',
  );
const dependencies = JSON.parse(
  run('gh', [
    'api',
    'repos/DanielssonThomas/Stellar/issues/50/dependencies/blocked_by',
  ]),
);
if (
  dependencies.length !== 1 ||
  dependencies[0].number !== 55 ||
  dependencies[0].state?.toLowerCase() !== 'closed'
)
  throw new Error('Issue #50 dependencies changed.');
if (
  git('-C', windowsWorktree, 'status', '--porcelain') ||
  wsl('git', '-C', linuxWorktree, 'status', '--porcelain')
)
  throw new Error('A #50 worktree is not clean.');
const claim = JSON.parse(
  run('node', ['tools/policy/manage-issue-worktree.mjs', 'inspect', '50']),
);
if (claim.state !== 'released')
  throw new Error('Issue #50 claim is not released.');
run('node', [
  'tools/policy/manage-issue-worktree.mjs',
  'claim',
  '50',
  '--worker',
  'peon',
  '--session-id',
  sessionId,
]);

// Both registered worktrees must fast-forward from a clean preserved branch.
git('-C', windowsWorktree, 'merge', '--ff-only', 'origin/develop');
wsl('git', '-C', linuxWorktree, 'fetch', 'origin', 'develop');
wsl('git', '-C', linuxWorktree, 'merge', '--ff-only', 'origin/develop');
const head = git('rev-parse', 'HEAD');
if (
  git('-C', windowsWorktree, 'rev-parse', 'HEAD') !== head ||
  wsl('git', '-C', linuxWorktree, 'rev-parse', 'HEAD') !== head
)
  throw new Error('Issue #50 worktrees are not at current develop.');
if (
  !existsSync(
    `${windowsWorktree}/libs/ui/atoms/src/lib/atoms/skeleton-atom.component.ts`,
  ) ||
  existsSync(
    `${windowsWorktree}/libs/ui/atoms/src/lib/atoms/skeleton-atom.component.spec.ts`,
  )
)
  throw new Error('Authorized source or new test path changed.');
const modelRunning = wsl(
  'podman',
  'inspect',
  '--format',
  '{{.State.Running}}',
  'stellar-peon-qwen',
);
if (modelRunning !== 'true') wsl('podman', 'start', 'stellar-peon-qwen');
const health = JSON.parse(
  wsl(
    'podman',
    'exec',
    'stellar-peon-qwen',
    'curl',
    '-fsS',
    'http://127.0.0.1:18435/health',
  ),
);
if (health.status !== 'ok')
  throw new Error('Existing Qwen container is not healthy.');

const result = await runSupervisedPeonIssue({
  issueNumber: 50,
  sessionId,
  image: trustedPeonWorkerImage,
  repositoryRoot: root,
  handoffPath,
  contextPlan: {
    skills: ['.agents/skills/implement-issue/SKILL.md'],
    files: [
      {
        kind: 'source',
        path: 'libs/ui/atoms/src/lib/atoms/skeleton-atom.component.ts',
        startLine: 1,
        endLine: 19,
      },
      {
        kind: 'test',
        path: 'libs/ui/atoms/src/lib/atoms/button-atom.component.spec.ts',
        startLine: 1,
        endLine: 35,
      },
    ],
    authorizedChangePaths: [
      'libs/ui/atoms/src/lib/atoms/skeleton-atom.component.ts',
      'libs/ui/atoms/src/lib/atoms/skeleton-atom.component.spec.ts',
    ],
  },
  verificationCommands: [
    { name: 'lint', command: ['pnpm', 'exec', 'nx', 'lint', 'ui-atoms'] },
    { name: 'vitest', command: ['pnpm', 'exec', 'nx', 'test', 'ui-atoms'] },
    { name: 'build', command: ['pnpm', 'exec', 'nx', 'build', 'ui-atoms'] },
  ],
});
const remaining = [
  'stellar-peon-worker-50-1',
  'stellar-peon-meter-50-1',
].filter(
  (name) =>
    spawnSync(
      'wsl.exe',
      [
        '--distribution',
        'Ubuntu',
        '--user',
        'peon',
        '--exec',
        'podman',
        'container',
        'exists',
        name,
      ],
      { windowsHide: true },
    ).status === 0,
);
console.log(
  JSON.stringify(
    {
      issue: 50,
      sessionId,
      status: result.status,
      handoffPath,
      attempt: result.handoff?.attempts?.at(-1) ?? null,
      remainingAttemptContainers: remaining,
    },
    null,
    2,
  ),
);
