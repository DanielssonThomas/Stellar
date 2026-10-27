/** Offline #50 reference only: pinned Hermes prompt inspection and local tokenization. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  buildHermesPromptInspectionArgs,
  buildHermesTaskInput,
} from '../run-restricted-worker.mjs';
import {
  buildPeonTaskContextManifest,
  buildMinimalPeonTaskContextManifest,
} from '../peon-task-context.mjs';
import { loadIssue } from '../manage-issue-worktree.mjs';
import { trustedPeonWorkerImage } from '../supervised-peon-run.mjs';

const repositoryRoot = process.cwd();
const worktreePath = path.resolve(repositoryRoot, '..', 'stellar-issue-50');
const workspace = '/home/peon/workspaces/issue-50';
const files = [
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
];
function run(command, args, input, trim = true) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 105_000,
    maxBuffer: 8 * 1024 * 1024,
    ...(input === undefined ? {} : { input }),
  });
  if (result.error || result.status !== 0)
    throw new Error('offline_minimal_measurement_failed');
  return trim ? result.stdout.trim() : result.stdout;
}
function wsl(...args) {
  return run('wsl.exe', [
    '--distribution',
    'Ubuntu',
    '--user',
    'peon',
    '--exec',
    ...args,
  ]);
}
function wslPath(file) {
  return wsl('wslpath', '-a', '-u', file);
}
function inspect(minimalGuidanceSource) {
  const args = buildHermesPromptInspectionArgs({
    image: trustedPeonWorkerImage,
    uid: 1001,
    gid: 1001,
    workspace,
    hermesConfigSource: wslPath(
      path.join(repositoryRoot, 'tools/policy/peon-hermes-narrow-config.yaml'),
    ),
    inspectionScriptSource: wslPath(
      path.join(repositoryRoot, 'tools/policy/inspect-hermes-system-prompt.py'),
    ),
    runnerScriptSource: wslPath(
      path.join(
        repositoryRoot,
        'tools/policy/run-hermes-system-prompt-inspection.sh',
      ),
    ),
    minimalGuidanceSource,
  });
  return JSON.parse(
    run('wsl.exe', [
      '--distribution',
      'Ubuntu',
      '--user',
      'peon',
      '--exec',
      'podman',
      ...args,
      '--study-export',
    ]),
  );
}
const issue = loadIssue(50);
if (
  issue.number !== 50 ||
  issue.state !== 'OPEN' ||
  run('git', ['-C', worktreePath, 'status', '--porcelain=v1'])
)
  throw new Error('Historical reference workspace is unavailable or dirty.');
const head = run('git', ['-C', worktreePath, 'rev-parse', 'HEAD']);
const original = inspect();
const minimal = inspect(
  wslPath(path.join(repositoryRoot, 'tools/policy/peon-coding-agents.md')),
);
if (
  original.schema !== 'stellar.hermes-prompt-study/v1' ||
  minimal.schema !== original.schema ||
  original.toolSchemas.length !== minimal.toolSchemas.length
)
  throw new Error('Pinned Hermes prompt comparison is incomplete.');
const originalGuidance = run(
  'wsl.exe',
  [
    '--distribution',
    'Ubuntu',
    '--user',
    'peon',
    '--exec',
    'cat',
    '--',
    `${workspace}/AGENTS.md`,
  ],
  undefined,
  false,
);
const boundedTask = {
  issueNumber: 50,
  owner: 'worker:peon',
  targetBranch: 'develop',
  branch: run('git', ['-C', worktreePath, 'branch', '--show-current']),
  hermesWorkflow: 'bounded-coding',
  maxForwardedRequests: 2,
};
const bounded = buildPeonTaskContextManifest({
  issue,
  task: boundedTask,
  repositoryRoot,
  worktreePath,
  headRevision: head,
  contextPlan: {
    skills: ['.agents/skills/implement-issue/SKILL.md'],
    files,
    authorizedChangePaths: [
      files[0].path,
      'libs/ui/atoms/src/lib/atoms/skeleton-atom.component.spec.ts',
    ],
  },
  systemPromptGuidanceAttestation: {
    path: 'AGENTS.md',
    guidanceSha256: createHash('sha256').update(originalGuidance).digest('hex'),
    systemPromptSha256: original.systemPromptSha256,
  },
});
const minimalTask = { issueNumber: 50, hermesWorkflow: 'minimal-coding' };
const brief = buildMinimalPeonTaskContextManifest({
  issue,
  task: minimalTask,
  worktreePath,
  contextPlan: {
    skills: [],
    files,
    authorizedChangePaths: ['libs/ui/atoms/src/lib/atoms'],
  },
});
const boundedInput = buildHermesTaskInput(boundedTask, bounded);
const minimalInput = buildHermesTaskInput(minimalTask, brief);
const request = (exported, input) => ({
  model: exported.model,
  messages: [
    { role: 'system', content: exported.systemPrompt },
    { role: 'user', content: input },
  ],
  tools: exported.toolSchemas,
  stream: false,
  max_tokens: 1500,
});
const corpus = {
  syntheticFixedSystemTokens: 1,
  requests: {
    baseline: [request(original, boundedInput)],
    minimal: [request(minimal, minimalInput)],
  },
  tokenizeOnly: [
    {
      kind: 'baseline-system',
      content: original.systemPrompt,
      addSpecial: false,
    },
    {
      kind: 'minimal-system',
      content: minimal.systemPrompt,
      addSpecial: false,
    },
    {
      kind: 'baseline-tools',
      content: JSON.stringify(original.toolSchemas),
      addSpecial: false,
    },
    {
      kind: 'minimal-tools',
      content: JSON.stringify(minimal.toolSchemas),
      addSpecial: false,
    },
    { kind: 'baseline-input', content: boundedInput, addSpecial: false },
    { kind: 'minimal-input', content: minimalInput, addSpecial: false },
  ],
};
const measured = JSON.parse(
  run(
    process.execPath,
    [
      path.join(
        repositoryRoot,
        'tools/policy/context-study/tokenize-corpus-via-local-qwen.mjs',
      ),
      '--stdin',
    ],
    JSON.stringify(corpus),
  ),
);
if (measured.completionRequests !== 0 || measured.meteringProxyRequests !== 0)
  throw new Error('Offline measurement attempted inference or metering.');
process.stdout.write(
  JSON.stringify({
    referenceIssue: 50,
    revision: head,
    pinnedImage: trustedPeonWorkerImage,
    toolCounts: {
      baseline: original.toolSchemas.length,
      minimal: minimal.toolSchemas.length,
    },
    promptTokens: {
      baseline: measured.promptScenarios.baseline[0],
      minimal: measured.promptScenarios.minimal[0],
    },
    componentTokens: measured.tokenizeOnly,
    componentBytes: {
      baselineInput: Buffer.byteLength(boundedInput),
      minimalInput: Buffer.byteLength(minimalInput),
      baselineSystem: Buffer.byteLength(original.systemPrompt),
      minimalSystem: Buffer.byteLength(minimal.systemPrompt),
      baselineTools: Buffer.byteLength(JSON.stringify(original.toolSchemas)),
      minimalTools: Buffer.byteLength(JSON.stringify(minimal.toolSchemas)),
    },
    completionRequests: 0,
    meteringProxyRequests: 0,
  }) + '\n',
);
