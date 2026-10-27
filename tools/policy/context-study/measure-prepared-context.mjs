import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import {
  buildHermesPromptInspectionArgs,
  buildHermesTaskInput,
} from '../run-restricted-worker.mjs';
import { buildPeonTaskContextManifest } from '../peon-task-context.mjs';
import { loadIssue } from '../manage-issue-worktree.mjs';
import { trustedPeonWorkerImage } from '../supervised-peon-run.mjs';

const workspace = '/home/peon/workspaces/issue-50';
const issueNumber = 50;
const repositoryRoot = process.cwd();
const byteLimit = 8 * 1024 * 1024;

function run(command, args, { input, timeout = 30_000 } = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    windowsHide: true,
    timeout,
    maxBuffer: byteLimit,
    ...(input === undefined ? {} : { input }),
  });
  if (result.error || result.status !== 0)
    throw new Error('offline_measurement_step_failed');
  return result.stdout ?? '';
}

function wsl(...args) {
  return run('wsl.exe', [
    '--distribution',
    'Ubuntu',
    '--user',
    'peon',
    '--exec',
    ...args,
  ]).trim();
}

function wslPath(windowsPath) {
  return wsl('wslpath', '-a', '-u', windowsPath);
}

function readWorkspaceFile(relativePath) {
  const normalized = relativePath.replaceAll('\\', '/');
  if (
    normalized.startsWith('/') ||
    normalized.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('invalid_measurement_path');
  const output = run('wsl.exe', [
    '--distribution',
    'Ubuntu',
    '--user',
    'peon',
    '--exec',
    'cat',
    '--',
    `${workspace}/${normalized}`,
  ]);
  return output;
}

function inspectPinnedPrompt() {
  const config = wslPath(
    path.join(
      repositoryRoot,
      'tools',
      'policy',
      'peon-hermes-narrow-config.yaml',
    ),
  );
  const inspector = wslPath(
    path.join(
      repositoryRoot,
      'tools',
      'policy',
      'inspect-hermes-system-prompt.py',
    ),
  );
  const runner = wslPath(
    path.join(
      repositoryRoot,
      'tools',
      'policy',
      'run-hermes-system-prompt-inspection.sh',
    ),
  );
  const soul = wslPath(
    path.join(
      repositoryRoot,
      'tools',
      'policy',
      'engineering-org',
      'templates',
      'peon',
      'soul.md',
    ),
  );
  const args = [
    '--distribution',
    'Ubuntu',
    '--user',
    'peon',
    '--exec',
    'podman',
    ...buildHermesPromptInspectionArgs({
      image: trustedPeonWorkerImage,
      uid: 1001,
      gid: 1001,
      workspace,
      hermesConfigSource: config,
      hermesSoulSource: soul,
      inspectionScriptSource: inspector,
      runnerScriptSource: runner,
    }),
    '--study-export',
  ];
  const output = run('wsl.exe', args, { timeout: 30_000 });
  const exported = JSON.parse(output);
  if (
    exported?.schema !== 'stellar.hermes-prompt-study/v1' ||
    exported.exactMatchCount !== 1 ||
    exported.networkRequests !== undefined ||
    !/^[a-f0-9]{64}$/.test(exported.agentsSha256 ?? '') ||
    !/^[a-f0-9]{64}$/.test(exported.systemPromptSha256 ?? '') ||
    typeof exported.systemPrompt !== 'string' ||
    !Array.isArray(exported.toolSchemas)
  )
    throw new Error('invalid_pinned_prompt_inspection');
  return exported;
}

function buildPreparedInputs(issue, exported, agentsContent, head, branch) {
  const task = {
    issueNumber,
    owner: 'worker:peon',
    targetBranch: 'develop',
    branch,
    hermesWorkflow: 'bounded-coding',
    maxForwardedRequests: 2,
  };
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
  const systemPromptGuidanceAttestation = {
    path: 'AGENTS.md',
    guidanceSha256: createHash('sha256').update(agentsContent).digest('hex'),
    systemPromptSha256: exported.systemPromptSha256,
  };
  const prepared = buildPeonTaskContextManifest({
    issue,
    task,
    repositoryRoot,
    worktreePath: workspace,
    workspaceIdentity: workspace,
    headRevision: head,
    workspaceReader: readWorkspaceFile,
    protectedPaths: [],
    systemPromptGuidanceAttestation,
    contextPlan: {
      skills: ['.agents/skills/implement-issue/SKILL.md'],
      files,
      authorizedChangePaths: [
        files[0].path,
        'libs/ui/atoms/src/lib/atoms/skeleton-atom.component.spec.ts',
      ],
    },
  });
  const currentInput = buildHermesTaskInput(task, prepared);

  const baselineManifest = structuredClone(prepared.manifest);
  const agents = baselineManifest.guidance.find(
    ({ path: relativePath }) => relativePath === 'AGENTS.md',
  );
  delete agents.source;
  delete agents.systemPromptSha256;
  agents.content = agentsContent;
  baselineManifest.issue.untrustedIssueBody = issue.body ?? '';
  const baselinePrepared = {
    manifest: baselineManifest,
    serialized: JSON.stringify(baselineManifest),
  };
  const baselineInput = buildHermesTaskInput(task, baselinePrepared);
  return { currentInput, baselineInput };
}

function toolCallHistory(exported) {
  const terminalSchema = exported.toolSchemas.find(
    (schema) => schema?.function?.name === 'terminal',
  );
  const commandField = terminalSchema?.function?.parameters?.required?.[0];
  if (!commandField) throw new Error('terminal_tool_schema_unavailable');
  const command = [
    'set -eu',
    "cat > libs/ui/atoms/src/lib/atoms/skeleton-atom.component.ts <<'STELLAR_COMPONENT'",
    "import { Component, computed, input } from '@angular/core';",
    "import clsx from 'clsx';",
    "export type SkeletonShape = 'text' | 'control' | 'avatar';",
    '@Component({ selector: "stellar-skeleton-atom", standalone: true, template: \'<span [class]="classes()" aria-hidden="true"></span>\' })',
    'export class SkeletonAtom {',
    "  readonly shape = input<SkeletonShape>('text');",
    "  readonly classes = computed(() => clsx('inline-block animate-pulse rounded-stellar bg-stellar-skeleton', {",
    "    'h-4 w-24': this.shape() === 'text',",
    "    'h-5 w-20': this.shape() === 'control',",
    "    'h-12 w-12 rounded-full': this.shape() === 'avatar',",
    '  }));',
    '}',
    'STELLAR_COMPONENT',
    "cat > libs/ui/atoms/src/lib/atoms/skeleton-atom.component.spec.ts <<'STELLAR_TEST'",
    "import { TestBed } from '@angular/core/testing';",
    "import { SkeletonAtom } from './skeleton-atom.component';",
    "describe('SkeletonAtom', () => {",
    "  it('renders the avatar silhouette', async () => {",
    '    await TestBed.configureTestingModule({ imports: [SkeletonAtom] }).compileComponents();',
    '    const fixture = TestBed.createComponent(SkeletonAtom);',
    "    fixture.componentRef.setInput('shape', 'avatar');",
    '    fixture.detectChanges();',
    '    expect(fixture.nativeElement.querySelector("span").className).toContain("rounded-full");',
    '  });',
    '});',
    'STELLAR_TEST',
    'pnpm exec nx lint ui-atoms',
    'pnpm exec nx test ui-atoms',
    'pnpm exec nx build ui-atoms',
    'git add libs/ui/atoms/src/lib/atoms/skeleton-atom.component.ts libs/ui/atoms/src/lib/atoms/skeleton-atom.component.spec.ts',
    'git commit -m "[#50] feat(ui-atoms): add avatar skeleton shape"',
    'git push origin HEAD',
  ].join('\n');
  const call = {
    id: 'call_bounded_attempt_01',
    type: 'function',
    function: {
      name: 'terminal',
      arguments: JSON.stringify({ [commandField]: command }),
    },
  };
  return [
    { role: 'assistant', content: null, tool_calls: [call] },
    {
      role: 'tool',
      tool_call_id: call.id,
      name: 'terminal',
      content:
        'Trusted terminal returned exit code 0. Scoped lint, Vitest, and build completed; issue-linked commit and fork push completed.',
    },
  ];
}

async function main() {
  const issue = loadIssue(issueNumber);
  if (issue.number !== issueNumber || issue.state !== 'OPEN')
    throw new Error('issue_identity_unavailable');
  const head = wsl('git', '-C', workspace, 'rev-parse', 'HEAD');
  const branch = wsl('git', '-C', workspace, 'branch', '--show-current');
  const status = wsl(
    'git',
    '-C',
    workspace,
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
  );
  if (status || !/^[a-f0-9]{40,64}$/.test(head))
    throw new Error('issue_workspace_not_clean');

  const exported = inspectPinnedPrompt();
  const agentsContent = readWorkspaceFile('AGENTS.md');
  if (
    createHash('sha256').update(agentsContent).digest('hex') !==
    exported.agentsSha256
  )
    throw new Error('agents_identity_mismatch');

  const { currentInput, baselineInput } = buildPreparedInputs(
    issue,
    exported,
    agentsContent,
    head,
    branch,
  );
  const history = toolCallHistory(exported);
  const generatedToolMessage = JSON.stringify(history[0]);
  const toolResultMessage = JSON.stringify(history[1]);
  const request = (input) => ({
    model: exported.model,
    messages: [
      { role: 'system', content: exported.systemPrompt },
      { role: 'user', content: input },
    ],
    tools: exported.toolSchemas,
    stream: false,
    max_tokens: 1_500,
  });
  const requests = {
    preChange: [
      request(baselineInput),
      {
        ...request(baselineInput),
        messages: [
          { role: 'system', content: exported.systemPrompt },
          { role: 'user', content: baselineInput },
          ...history,
        ],
      },
    ],
    revised: [
      request(currentInput),
      {
        ...request(currentInput),
        messages: [
          { role: 'system', content: exported.systemPrompt },
          { role: 'user', content: currentInput },
          ...history,
        ],
      },
    ],
  };
  const corpus = JSON.stringify({
    syntheticFixedSystemTokens: 1,
    requests,
    tokenizeOnly: [
      {
        kind: 'prepared-manifest',
        content: JSON.stringify(
          JSON.parse(currentInput.split('TRUSTED_TASK_CONTEXT_JSON\n')[1]),
        ),
        addSpecial: false,
      },
      ...JSON.parse(currentInput.split('TRUSTED_TASK_CONTEXT_JSON\n')[1])
        .guidance.filter((entry) => typeof entry.content === 'string')
        .map((entry) => ({
          kind: 'guidance-content',
          name: entry.path,
          content: entry.content,
          addSpecial: false,
        })),
      ...JSON.parse(
        currentInput.split('TRUSTED_TASK_CONTEXT_JSON\n')[1],
      ).excerpts.map((entry) => ({
        kind: 'task-excerpt',
        name: entry.path,
        content: entry.content,
        addSpecial: false,
      })),
      {
        kind: 'issue-body-with-criteria',
        content: issue.body ?? '',
        addSpecial: false,
      },
      {
        kind: 'issue-objective-and-constraints',
        content: (() => {
          const selected = JSON.parse(
            currentInput.split('TRUSTED_TASK_CONTEXT_JSON\n')[1],
          ).issue;
          return `${selected.objective}\n${selected.constraints}`;
        })(),
        addSpecial: false,
      },
      {
        kind: 'verified-agents-guidance-content',
        content: agentsContent,
        addSpecial: false,
      },
      {
        kind: 'synthetic-first-completion-tool-call-json',
        content: generatedToolMessage,
        addSpecial: false,
      },
      {
        kind: 'synthetic-terminal-tool-result-json',
        content: toolResultMessage,
        addSpecial: false,
      },
      {
        kind: 'runtime-system-prompt',
        content: exported.systemPrompt,
        addSpecial: false,
      },
    ],
    endpointClass: 'local-tokenize-and-apply-template-only',
  });
  const bridge = run(
    process.execPath,
    [
      path.join(
        repositoryRoot,
        'tools',
        'policy',
        'context-study',
        'tokenize-corpus-via-local-qwen.mjs',
      ),
      '--stdin',
    ],
    { input: corpus, timeout: 105_000 },
  );
  const measured = JSON.parse(bridge);
  if (measured.completionRequests !== 0 || measured.meteringProxyRequests !== 0)
    throw new Error('unexpected_completion_or_metering_request');

  const prompt = measured.promptScenarios;
  const result = {
    sourceImage: trustedPeonWorkerImage,
    hermesModel: exported.model,
    workspaceRevision: head,
    systemPromptSha256: exported.systemPromptSha256,
    agentsSha256: exported.agentsSha256,
    toolCount: exported.toolSchemas.length,
    promptTokens: {
      preChangeRequest1: prompt.preChange[0],
      revisedRequest1: prompt.revised[0],
      request1Saved: prompt.preChange[0] - prompt.revised[0],
      preChangeRequest2: prompt.preChange[1],
      revisedRequest2: prompt.revised[1],
      request2Saved: prompt.preChange[1] - prompt.revised[1],
      preChangeTotal: prompt.preChange.reduce((sum, value) => sum + value, 0),
      revisedTotal: prompt.revised.reduce((sum, value) => sum + value, 0),
    },
    tokenizeOnly: measured.tokenizeOnly,
    syntheticHistory:
      'one terminal edit/check/commit/push tool call plus a successful tool result',
    completionRequests: measured.completionRequests,
    meteringProxyRequests: measured.meteringProxyRequests,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch(() => {
  process.stderr.write('prepared_context_measurement_failed\n');
  process.exitCode = 1;
});
