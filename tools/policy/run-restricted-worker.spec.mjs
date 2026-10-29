import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  mkdtemp,
  mkdir,
  writeFile,
  unlink,
  rename,
  symlink,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import filesystem from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import {
  buildWorkerImageInspectionArgs,
  buildHermesPromptInspectionArgs,
  buildMeteringProxyArgs,
  buildPodmanArgs,
  assertMeterIdentityUnchanged,
  readMeterContainerIdentity,
  readLiveMeterUsage,
  buildRestrictedVerificationArgs,
  buildHermesTaskCommand,
  captureBoundedDiagnosticStream,
  classifyHermesPromptInspectionFailure,
  cancelRestrictedVerification,
  createPeonWorkerAdapter,
  formatWorkerFailure,
  parseArguments,
  redactWorkerDiagnostics,
  runRestrictedWorker,
  waitForMeter,
  inspectRestrictedWorkspace,
} from './run-restricted-worker.mjs';
import {
  appendMentorFeedback,
  correctionFeedbackFromHandoff,
  withCurrentCorrectionFeedback,
  readHandoff,
  superviseWorker,
} from './supervise-worker.mjs';
import {
  runSupervisedPeonIssue,
  validateLivePeonAssignment,
} from './supervised-peon-run.mjs';
import {
  defaultPeonHermesProfile,
  peonHermesConfigFilename,
} from './peon-hermes-profiles.mjs';

const image = `ghcr.io/stellar-ai-corp/hermes-worker@sha256:${'a'.repeat(64)}`;
const trustedFocusConfig =
  '/mnt/d/ai-repositories/stellar-issue-82/tools/policy/peon-hermes-config.yaml';
const trustedFocusSoul =
  '/mnt/d/ai-repositories/stellar-issue-82/tools/policy/engineering-org/templates/peon/soul.md';
const evidenceConfig =
  '/mnt/d/ai-repositories/stellar/tools/policy/peon-hermes-evidence-config.yaml';
const evidenceHook =
  '/mnt/d/ai-repositories/stellar/tools/policy/record-peon-tool-event.py';
const meterSource =
  '/mnt/d/ai-repositories/stellar/tools/policy/peon-metering-proxy-evidence.mjs';
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

// Exercise the production inspector, replacing only WSL command transport.
function localInspectionCommand(args, options) {
  let command = args[0];
  let parameters = args.slice(1);
  if (command === 'python3' && process.platform === 'win32') {
    parameters[2] = parameters[2]
      .replace(/^([A-Za-z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`)
      .replaceAll('\\', '/');
    command = 'wsl.exe';
    parameters = [
      '--distribution',
      'Ubuntu',
      '--exec',
      'python3',
      ...parameters,
    ];
  }
  const result = spawnSync(command, parameters, {
    ...options,
    windowsHide: true,
  });
  if (result.error || result.status !== 0)
    throw new Error('Test workspace inspection failed.');
  return new TextDecoder('utf-8', { fatal: true }).decode(result.stdout);
}

async function inspectionFixture(t, number = 222) {
  const directory = await mkdtemp(path.join(tmpdir(), 'stellar-inspection-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = directory.replaceAll('\\', '/');
  const git = (...args) =>
    localInspectionCommand(['git', '-C', workspace, ...args], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
  git('init', '--quiet');
  git(
    '-c',
    'user.name=Stellar Tests',
    '-c',
    'user.email=stellar-tests@example.invalid',
    'commit',
    '--quiet',
    '--allow-empty',
    '-m',
    'fixture',
  );
  git('checkout', '--quiet', '-b', `issue/${number}-inspection`);
  await mkdir(path.join(directory, 'src'));
  const inspect = (runCommand = localInspectionCommand) =>
    inspectRestrictedWorkspace(
      number,
      `issue/${number}-inspection`,
      undefined,
      {
        workspace,
        runCommand,
      },
    );
  return { directory, workspace, git, inspect };
}

test('production fingerprint tracks untracked contents and rejects stale mentor feedback', async (t) => {
  const { directory, inspect } = await inspectionFixture(t);
  const empty = inspect().fingerprint;
  const file = path.join(directory, 'src', 'new file.ts');
  await writeFile(file, 'export const value = 1;\n');
  const added = inspect().fingerprint;
  assert.notEqual(added, empty);
  assert.equal(inspect().fingerprint, added);
  const handoffDirectory = await mkdtemp(
    path.join(tmpdir(), 'stellar-inspection-handoff-'),
  );
  t.after(() => rm(handoffDirectory, { recursive: true, force: true }));
  const handoffPath = path.join(handoffDirectory, 'handoff.json');
  const inspectWorktree = async () => inspect();
  await superviseWorker({
    task: {
      issueNumber: 222,
      owner: 'owner:codex',
      targetBranch: 'develop',
      branch: 'issue/222-inspection',
      worktreePath: directory,
    },
    handoffPath,
    inspectWorktree,
    limits: { maxAttemptsPerWorker: 1 },
    workers: {
      peon: {
        id: 'peon',
        run: async () => ({
          status: 'failed',
          failure: { message: 'Missing required field.' },
        }),
      },
      mira: {
        id: 'mira',
        run: async () => {
          throw new Error('No Mira');
        },
      },
    },
    verify: async () => [{ passed: true }],
  });
  const stopped = await readHandoff(handoffPath);
  await writeFile(file, 'export const value = 999;\n');
  const modified = inspect().fingerprint;
  assert.notEqual(modified, added);
  assert.equal(inspect().fingerprint, modified);
  const feedback = {
    handoffPath,
    issueNumber: 222,
    attemptNumber: 1,
    expectedUpdatedAt: stopped.updatedAt,
    expectedFingerprint: stopped.attempts[0].afterFingerprint,
    evidence: { kind: 'failure' },
    inspectWorktree,
  };
  for (const level of ['diagnostic', 'conceptual'])
    await assert.rejects(
      appendMentorFeedback({
        ...feedback,
        level,
        guidance: 'Inspect the field.',
      }),
      /Worktree changed/,
    );
  const attributed = await appendMentorFeedback({
    ...feedback,
    level: 'codex-fix',
    guidance: 'Codex changed the source.',
  });
  assert.equal(attributed.implementationAuthor, 'codex');
  assert.notEqual(attributed.resultFingerprint, attributed.fingerprint);
  await unlink(file);
  assert.notEqual(inspect().fingerprint, modified);
  await writeFile(file, 'replacement');
  assert.notEqual(inspect().fingerprint, modified);
  assert.match(inspect().fingerprint, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(inspect()).includes('replacement'));
});

test('contains the real persistence-write race by denying correction before reservation or launch', async (t) => {
  const { directory, git, inspect } = await inspectionFixture(t, 50);
  const file = path.join(directory, 'src', 'tracked.ts');
  await writeFile(file, 'packet version\n');
  await mkdir(path.join(directory, 'tools', 'policy'), { recursive: true });
  await writeFile(
    path.join(directory, 'tools', 'policy', 'peon-coding-agents.md'),
    'Offline guidance.\n',
  );
  git('add', '.');
  git(
    '-c',
    'user.name=Tests',
    '-c',
    'user.email=tests@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  );
  const revision = git('rev-parse', 'HEAD').trim();
  const evidence = await mkdtemp(
    path.join(tmpdir(), 'stellar-dispatch-denial-'),
  );
  t.after(() => rm(evidence, { recursive: true, force: true }));
  const source = path.join(evidence, 'source.json');
  const destination = path.join(evidence, 'destination.json');
  const host = path.join(evidence, 'host');
  await mkdir(path.join(host, 'tools', 'policy'), { recursive: true });
  await writeFile(
    path.join(host, 'tools', 'policy', 'peon-coding-agents.md'),
    'Offline guidance.\n',
  );
  const issue = {
    number: 50,
    state: 'OPEN',
    body: '## Objective\nCorrect source.\n## Expected outcome\nOne fix.\n## Acceptance criteria\n- [ ] Fix source.\n## Constraints\nOnly src.\n## Dependencies\nNone\n## Verification expectations\nOffline checks.',
    labels: [
      'priority:low',
      'target:develop',
      'type:feature',
      'status:in-progress',
      'worker:peon',
      'hermes-profile:narrow-coding',
      'hermes-workflow:minimal-coding',
    ],
    dependencies: [],
  };
  const sessionId = 'offline-dispatch-denial';
  const claim = {
    state: 'active',
    worker: 'worker:peon',
    sessionId,
    target: 'develop',
    branch: 'issue/50-inspection',
    worktreePath: directory,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  };
  const task = validateLivePeonAssignment({ issue, claim, sessionId });
  const inspectWorktree = async () => ({
    ...inspect(),
    baseRevision: revision,
  });
  await superviseWorker({
    task,
    handoffPath: source,
    inspectWorktree,
    verify: async () => [],
    limits: { maxAttemptsPerWorker: 1 },
    workers: {
      peon: {
        id: 'peon',
        run: async () => ({
          status: 'failed',
          failure: { message: 'Missing field.' },
        }),
      },
      mira: {
        id: 'mira',
        run: async () => {
          throw new Error('No Mira');
        },
      },
    },
  });
  const stopped = await readHandoff(source);
  await appendMentorFeedback({
    handoffPath: source,
    issueNumber: 50,
    attemptNumber: 1,
    expectedUpdatedAt: stopped.updatedAt,
    expectedFingerprint: stopped.attempts[0].afterFingerprint,
    level: 'diagnostic',
    evidence: { kind: 'failure' },
    inspectWorktree,
  });
  const feedback = await correctionFeedbackFromHandoff({
    handoffPath: source,
    issueNumber: 50,
    inspectWorktree,
  });
  const before = await filesystem.readFile(source, 'utf8');
  let mutation = false;
  let launched = false;
  const originalRename = filesystem.rename;
  filesystem.rename = async (from, to) => {
    // Same scheduling boundary as the independent review: a genuine write
    // after validation, while source consumption is being persisted.
    if (
      to === source &&
      JSON.parse(await filesystem.readFile(from, 'utf8')).status ===
        'superseded'
    ) {
      await writeFile(file, 'changed during consumption\n');
      mutation = true;
    }
    return originalRename(from, to);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      runSupervisedPeonIssue({
        issueNumber: 50,
        sessionId,
        repositoryRoot: host,
        handoffPath: destination,
        verificationCommands: [
          { name: 'offline', command: ['node', '--test'] },
        ],
        contextPlan: {
          skills: [],
          files: [
            {
              kind: 'source',
              path: 'src/tracked.ts',
              startLine: 1,
              endLine: 1,
            },
          ],
          authorizedChangePaths: ['src'],
          mentorFeedback: feedback,
        },
        loadAssignment: async () => issue,
        readClaim: async () => claim,
        inspectWorktree,
        inspectRegisteredWorktree: async () => ({
          clean: true,
          headRevision: revision,
        }),
        resolveDevelopHead: async () => revision,
        readWorkspaceFile: (_number, name) =>
          readFileSync(path.join(directory, name), 'utf8'),
        getProtectedPaths: () => [],
        verifyImageCompatibility: async () => ({}),
        verifySystemPromptGuidance: async () => ({}),
        runVerification: async () => ({ exitCode: 0 }),
        createWorkerAdapter: (options) =>
          createPeonWorkerAdapter({
            ...options,
            runAttempt: async (input) => {
              launched = true;
              assert.equal(mutation, true);
              assert.match(input.taskInput, /packet version/);
              assert.equal(
                readFileSync(file, 'utf8'),
                'changed during consumption\n',
              );
              input.onUsageReady({ meterIdentity: {} });
              return { exitCode: 0, usage: { toolCalls: 0, modelTokens: 0 } };
            },
          }),
      }),
      /correction execution is unavailable/,
    );
  } finally {
    filesystem.rename = originalRename;
    syncBuiltinESMExports();
  }
  assert.equal(launched, false);
  assert.equal(mutation, false);
  assert.equal(await filesystem.readFile(source, 'utf8'), before);
  await assert.rejects(filesystem.readFile(destination), /ENOENT/);
  await assert.rejects(
    filesystem.stat(path.join(evidence, '.stellar-supervisor-state')),
    /ENOENT/,
  );
  // Ordinary filesystem writers still can write: do not call this isolation.
  await writeFile(file, 'independent writer\n');
  await assert.rejects(
    correctionFeedbackFromHandoff({
      handoffPath: source,
      issueNumber: 50,
      inspectWorktree,
    }),
    /source changed/,
  );
});

test('production inspection handles tracked changes, renames and unusual path delimiters', async (t) => {
  const { directory, git, inspect } = await inspectionFixture(t);
  const name =
    process.platform === 'win32' ? 'spaced é.ts' : 'space\nquote"\\é.ts';
  const original = path.join(directory, 'src', name);
  await writeFile(original, 'original');
  assert.deepEqual(inspect().changes, [`src/${name}`]);
  git('add', '--', `src/${name}`);
  git(
    '-c',
    'user.name=Stellar Tests',
    '-c',
    'user.email=stellar-tests@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'tracked',
  );
  const clean = inspect().fingerprint;
  await writeFile(original, 'modified');
  assert.notEqual(inspect().fingerprint, clean);
  await rename(original, path.join(directory, 'src', 'renamed.ts'));
  git('add', '-A');
  const renamed = inspect();
  assert.ok(renamed.changes.includes(`src/${name}`));
  assert.ok(renamed.changes.includes('src/renamed.ts'));
  await unlink(path.join(directory, 'src', 'renamed.ts'));
  assert.notEqual(inspect().fingerprint, renamed.fingerprint);
});

test('production discovery overrides Git stat/cache shortcuts without clearing index flags', async (t) => {
  const { directory, git, inspect } = await inspectionFixture(t);
  const file = path.join(directory, 'src', 'tracked.ts');
  await writeFile(file, 'before');
  git('add', '.');
  git(
    '-c',
    'user.name=Tests',
    '-c',
    'user.email=tests@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  );
  const before = inspect().fingerprint;
  for (const [key, value] of [
    ['core.ignorestat', 'true'],
    ['core.trustctime', 'false'],
    ['core.checkstat', 'minimal'],
    ['core.untrackedCache', 'true'],
    ['core.fsmonitor', 'nonexistent-monitor-must-not-run'],
  ])
    git('config', key, value);
  await writeFile(file, 'after!');
  const changed = inspect();
  assert.notEqual(changed.fingerprint, before);
  assert.equal(changed.clean, false);
  assert.deepEqual(changed.changes, ['src/tracked.ts']);
  assert.match(
    git('-c', 'core.fsmonitor=false', 'ls-files', '-v', '-z'),
    /^H /,
  );
});

test('production index admission rejects hidden tracked edits and stale feedback for both flags', async (t) => {
  for (const flag of ['assume-unchanged', 'skip-worktree']) {
    const { directory, git, inspect } = await inspectionFixture(t);
    const name =
      process.platform === 'win32' ? 'src/tracked é.ts' : 'src/tracked\n"é.ts';
    const file = path.join(directory, name);
    await writeFile(file, 'export const value = 1;\n');
    git('add', '--', name);
    git(
      '-c',
      'user.name=Tests',
      '-c',
      'user.email=tests@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'tracked',
    );
    assert.equal(inspect().clean, true);
    const before = inspect().fingerprint;
    git('update-index', `--${flag}`, '--', name);
    assert.throws(() => inspect(), /Unsafe.*index/);
    await writeFile(file, 'export const value = 999;\n');
    assert.equal(git('status', '--porcelain=v1', '-z'), '');
    assert.throws(() => inspect(), /Unsafe.*index/);
    // Detection never silently clears the unsafe flag.
    assert.match(
      git('ls-files', '-v', '-z'),
      flag === 'assume-unchanged' ? /^h / : /^S /,
    );
    git('update-index', `--no-${flag}`, '--', name);
    assert.notEqual(inspect().fingerprint, before);
    await writeFile(file, 'export const value = 1;\n');
    const handoffs = await mkdtemp(
      path.join(tmpdir(), 'stellar-index-feedback-'),
    );
    t.after(() => rm(handoffs, { recursive: true, force: true }));
    const handoffPath = path.join(handoffs, 'source.json');
    const task = {
      issueNumber: 222,
      owner: 'owner:codex',
      targetBranch: 'develop',
      branch: 'issue/222-inspection',
      worktreePath: directory,
    };
    const inspectWorktree = async () => inspect();
    await superviseWorker({
      task,
      handoffPath,
      inspectWorktree,
      limits: { maxAttemptsPerWorker: 1 },
      verify: async () => [],
      workers: {
        peon: {
          id: 'peon',
          run: async () => ({
            status: 'failed',
            failure: { message: 'Missing field.' },
          }),
        },
        mira: {
          id: 'mira',
          run: async () => {
            throw new Error('No Mira');
          },
        },
      },
    });
    const stopped = await readHandoff(handoffPath);
    await appendMentorFeedback({
      handoffPath,
      issueNumber: 222,
      attemptNumber: 1,
      expectedUpdatedAt: stopped.updatedAt,
      expectedFingerprint: stopped.attempts[0].afterFingerprint,
      level: 'diagnostic',
      evidence: { kind: 'failure' },
      inspectWorktree,
    });
    const feedback = await correctionFeedbackFromHandoff({
      handoffPath,
      issueNumber: 222,
      inspectWorktree,
    });
    git('update-index', `--${flag}`, '--', name);
    await writeFile(file, 'export const value = 999;\n');
    await assert.rejects(
      correctionFeedbackFromHandoff({
        handoffPath,
        issueNumber: 222,
        inspectWorktree,
      }),
      /Unsafe.*index/,
    );
    let admitted = false;
    await assert.rejects(
      withCurrentCorrectionFeedback(
        feedback,
        {
          issueNumber: 222,
          destinationHandoffPath: path.join(handoffs, 'destination.json'),
        },
        async (_assert, consume) => {
          admitted = true;
          await consume(task, inspect());
        },
      ),
      /Unsafe.*index/,
    );
    assert.equal(admitted, false);
    assert.equal((await readHandoff(handoffPath)).status, 'handoff-pending');
  }
});

test('production index inspection fails closed on malformed, unavailable and changing evidence', async (t) => {
  const { directory, git, inspect } = await inspectionFixture(t);
  const file = path.join(directory, 'src', 'tracked.ts');
  await writeFile(file, 'one');
  git('add', '--', 'src/tracked.ts');
  const isIndex = (args) =>
    args.includes('ls-files') && args.includes('--stage');
  for (const evidence of [
    'H broken\0',
    'h 100644 ' + 'a'.repeat(40) + ' 0\tsrc/tracked.ts\0',
    'H 100644 ' + 'a'.repeat(40) + ' 0\t../escape\0',
    'unterminated',
    'x'.repeat(8 * 1024 * 1024 + 1) + '\0',
    ('H 100644 ' + 'a'.repeat(40) + ' 0\tx\0').repeat(100_001),
  ])
    assert.throws(
      () =>
        inspect((args, options) =>
          isIndex(args) ? evidence : localInspectionCommand(args, options),
        ),
      /index|path evidence/,
    );
  assert.throws(
    () =>
      inspect((args, options) => {
        if (isIndex(args)) throw new Error('index unavailable');
        return localInspectionCommand(args, options);
      }),
    /index unavailable/,
  );
  let read = false;
  assert.throws(
    () =>
      inspect((args, options) => {
        const result = localInspectionCommand(args, options);
        if (args[0] === 'python3' && !read) {
          read = true;
          git('update-index', '--skip-worktree', '--', 'src/tracked.ts');
        }
        return result;
      }),
    /Unsafe.*index/,
  );
  git('update-index', '--no-skip-worktree', '--', 'src/tracked.ts');
  read = false;
  assert.throws(
    () =>
      inspect((args, options) => {
        const result = localInspectionCommand(args, options);
        if (args[0] === 'python3' && !read) {
          read = true;
          assert.equal(
            spawnSync(process.execPath, [
              '-e',
              'require("fs").writeFileSync(process.argv[1], "new index blob")',
              file,
            ]).status,
            0,
          );
          git('add', '--', 'src/tracked.ts');
        }
        return result;
      }),
    /index changed during/,
  );
  // Git itself expands split indexes; flags must not disappear in that format.
  git('update-index', '--split-index');
  git('update-index', '--assume-unchanged', '--', 'src/tracked.ts');
  assert.throws(() => inspect(), /Unsafe.*index/);
});

test('production inspection fails closed on mutation, failures and oversized files', async (t) => {
  const { directory, inspect } = await inspectionFixture(t);
  const file = path.join(directory, 'src', 'new.ts');
  await writeFile(file, 'one');
  let hashes = 0;
  assert.throws(
    () =>
      inspect((args, options) => {
        const result = localInspectionCommand(args, options);
        if (args[0] === 'python3' && ++hashes === 1)
          // A real filesystem mutation between the two production snapshots.
          spawnSync(process.execPath, [
            '-e',
            'require("fs").writeFileSync(process.argv[1], "two")',
            file,
          ]);
        return result;
      }),
    /changed during/,
  );
  assert.throws(
    () =>
      inspect(() => {
        throw new Error('inspection unavailable');
      }),
    /unavailable/,
  );
  await writeFile(file, Buffer.alloc(8 * 1024 * 1024 + 1));
  assert.throws(() => inspect(), /inspection failed/);
});

test('production inspection rejects symlinks and special files', async (t) => {
  if (process.platform === 'win32')
    return t.skip('POSIX symlink/FIFO semantics are tested on Linux CI.');
  const { directory, inspect } = await inspectionFixture(t);
  const target = path.join(directory, 'target');
  await writeFile(target, 'private content');
  await symlink(target, path.join(directory, 'src', 'link'));
  assert.throws(() => inspect(), /inspection failed/);
  await unlink(path.join(directory, 'src', 'link'));
  const fifo = path.join(directory, 'src', 'pipe');
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
  assert.throws(() => inspect(), /inspection failed/);
  await unlink(fifo);
  await mkdir(path.join(directory, 'src', 'nested'));
  const nestedFifo = path.join(directory, 'src', 'nested', 'pipe');
  assert.equal(spawnSync('mkfifo', [nestedFifo]).status, 0);
  assert.throws(() => inspect(), /inspection failed/);
  await unlink(nestedFifo);
  await writeFile(path.join(directory, '.gitignore'), 'dependencies/\n');
  await mkdir(path.join(directory, 'dependencies'));
  await symlink(target, path.join(directory, 'dependencies', 'ignored-link'));
  assert.match(inspect().fingerprint, /^[a-f0-9]{64}$/);
});

test('minimal coding mounts only selected writable directories over a read-only workspace', () => {
  const workspace = '/home/peon/workspaces/issue-50';
  const guidance = '/mnt/d/repo/tools/policy/peon-coding-agents.md';
  const args = buildPodmanArgs({
    issueNumber: 50,
    image,
    uid: 1001,
    gid: 1001,
    command: ['hermes', 'chat'],
    protectedPaths,
    hermesProfile: 'narrow-coding',
    hermesConfigSource:
      '/mnt/d/repo/tools/policy/peon-hermes-narrow-config.yaml',
    writablePaths: ['libs/ui/atoms/src/lib/atoms'],
    minimalGuidanceSource: guidance,
  });
  assert.ok(
    args.includes(`--mount=type=bind,src=${workspace},dst=/workspace,ro`),
  );
  assert.ok(
    args.includes(
      `--mount=type=bind,src=${workspace}/libs/ui/atoms/src/lib/atoms,dst=/workspace/libs/ui/atoms/src/lib/atoms,rw`,
    ),
  );
  assert.ok(
    args.includes(
      `--mount=type=bind,src=${guidance},dst=/workspace/AGENTS.md,ro`,
    ),
  );
  assert.ok(
    !args.includes(
      `--mount=type=bind,src=${workspace}/AGENTS.md,dst=/workspace/AGENTS.md,ro`,
    ),
  );
  assert.ok(!args.some((arg) => arg.includes('target=GH_TOKEN')));
  assert.throws(
    () =>
      buildPodmanArgs({
        issueNumber: 50,
        image,
        uid: 1001,
        gid: 1001,
        command: ['hermes'],
        protectedPaths,
        hermesProfile: 'narrow-coding',
        hermesConfigSource:
          '/mnt/d/repo/tools/policy/peon-hermes-narrow-config.yaml',
        writablePaths: ['tools/policy'],
        minimalGuidanceSource: guidance,
      }),
    /trusted writable/,
  );
});

test('four-request worker and meter mount exact read-only evidence code without raising resource ceilings', () => {
  const worker = buildPodmanArgs({
    issueNumber: 50,
    image,
    uid: 1001,
    gid: 1001,
    protectedPaths,
    command: ['hermes', 'chat'],
    hermesProfile: 'narrow-evidence',
    hermesConfigSource: evidenceConfig,
    toolEvidenceSource: evidenceHook,
  });
  assert.ok(
    worker.includes(
      `--mount=type=bind,src=${evidenceHook},dst=/usr/local/libexec/record-peon-tool-event.py,ro`,
    ),
  );
  assert.ok(worker.includes('--memory=4g'));
  assert.ok(worker.includes('--cpus=2'));
  assert.throws(
    () =>
      buildPodmanArgs({
        issueNumber: 50,
        image,
        uid: 1001,
        gid: 1001,
        protectedPaths,
        command: ['hermes', 'chat'],
        hermesProfile: 'narrow-evidence',
        hermesConfigSource: evidenceConfig,
      }),
    /trusted tool evidence hook/,
  );
  const meter = buildMeteringProxyArgs({
    name: 'stellar-peon-meter-50-1',
    image,
    uid: 1001,
    gid: 1001,
    maxModelTokens: 52_000,
    maxToolCalls: 64,
    maxForwardedRequests: 4,
    meterSource,
  });
  assert.ok(meter.includes('--env=STELLAR_MAX_FORWARDED_REQUESTS=4'));
  assert.ok(meter.includes('--env=STELLAR_MAX_MODEL_TOKENS=52000'));
  assert.ok(
    meter.includes(
      `--mount=type=bind,src=${meterSource},dst=/opt/stellar-peon-metering-proxy-evidence.mjs,ro`,
    ),
  );
  assert.equal(meter.at(-1), '/opt/stellar-peon-metering-proxy-evidence.mjs');
  assert.ok(meter.includes('--memory=512m'));
  assert.throws(
    () =>
      buildMeteringProxyArgs({
        name: 'stellar-peon-meter-50-1',
        image,
        uid: 1001,
        gid: 1001,
        maxModelTokens: 32_000,
        maxToolCalls: 64,
        maxForwardedRequests: 4,
        meterSource,
      }),
    /exactly 52,000/,
  );
});

test('four-request adapter refuses to call a reported edit complete without executed-tool evidence', async () => {
  const manifest = {
    schema: 'stellar.peon-task-context/v1',
    issue: { number: 50 },
    authorization: {
      maxForwardedRequests: 4,
      limits: { modelTokens: 52_000 },
      allowedChangePaths: [
        'libs/ui/atoms/src/lib/atoms/skeleton-atom.component.ts',
      ],
    },
  };
  const adapter = createPeonWorkerAdapter({
    image,
    hermesProfile: 'narrow-evidence',
    maxForwardedRequests: 4,
    preparedContext: { manifest, serialized: JSON.stringify(manifest) },
    commandForTask: () => ['offline-test'],
    runAttempt: async () => ({
      exitCode: 0,
      usage: {
        toolCalls: 1,
        modelTokens: 100,
        forwardedRequests: 1,
        requestRecords: [{ emittedToolCalls: 1 }],
        toolEvents: [],
      },
    }),
  });
  const result = await adapter.run({
    task: {
      issueNumber: 50,
      hermesProfile: 'narrow-evidence',
      hermesWorkflow: 'edit-first-4',
      maxForwardedRequests: 4,
    },
    attemptNumber: 1,
    limits: { maxRuntimeMsPerWorker: 600_000, maxModelTokensPerWorker: 52_000 },
    budget: { snapshot: { toolCalls: 0, modelTokens: 0 } },
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.failure.code, 'ToolEvidenceIncomplete');
});

test('experimental launcher rejects mismatched profile and tokens before workspace access', async () => {
  await assert.rejects(
    runRestrictedWorker({
      issueNumber: 50,
      image,
      command: ['offline-test'],
      hermesProfile: 'narrow-coding',
      maxForwardedRequests: 4,
      limits: { maxModelTokensPerWorker: 52_000 },
    }),
    /profile, request count, and token ceiling must match/,
  );
  await assert.rejects(
    runRestrictedWorker({
      issueNumber: 50,
      image,
      command: ['offline-test'],
      hermesProfile: 'narrow-evidence',
      maxForwardedRequests: 4,
      limits: { maxModelTokensPerWorker: 32_000 },
    }),
    /profile, request count, and token ceiling must match/,
  );
});

test('builds a rootless, resource-bounded Podman invocation for one issue clone', () => {
  const args = buildPodmanArgs({
    issueNumber: 21,
    image,
    uid: 1001,
    gid: 1001,
    protectedPaths,
    command: ['hermes', '--issue', '21'],
    hermesConfigSource: trustedFocusConfig,
    hermesSoulSource: trustedFocusSoul,
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
    `--mount=type=bind,src=${trustedFocusConfig},dst=/tmp/.hermes/config.yaml,ro`,
    `--mount=type=bind,src=${trustedFocusSoul},dst=/tmp/.hermes/SOUL.md,ro`,
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
  assert.ok(
    args.includes(
      `--mount=type=bind,src=${trustedFocusConfig},dst=/tmp/.hermes/config.yaml,ro`,
    ),
  );
  assert.ok(
    args.includes(
      `--mount=type=bind,src=${trustedFocusSoul},dst=/tmp/.hermes/SOUL.md,ro`,
    ),
  );
  assert.equal(
    args.some((argument) =>
      argument.includes('/home/peon/workspaces/issue-21/tools/policy/'),
    ),
    false,
  );
  assert.equal(args.includes('--network=stellar-peon-model'), false);
  assert.equal(args.includes('--network=stellar-peon-egress'), false);
});

test('changes only the read-only Hermes config source for an opted-in profile', () => {
  const argsFor = (hermesProfile, hermesConfigSource) =>
    buildPodmanArgs({
      issueNumber: 50,
      image,
      uid: 1001,
      gid: 1001,
      protectedPaths,
      command: ['hermes', 'chat'],
      hermesProfile,
      hermesConfigSource,
      hermesSoulSource: trustedFocusSoul,
    });
  const focus = argsFor('focus', trustedFocusConfig);
  const narrowConfig = trustedFocusConfig.replace(
    'peon-hermes-config.yaml',
    'peon-hermes-narrow-config.yaml',
  );
  const narrow = argsFor('narrow-coding', narrowConfig);
  const withoutConfigMount = (args) =>
    args.filter(
      (argument) =>
        !argument.includes('dst=/tmp/.hermes/config.yaml') &&
        !argument.includes('dst=/tmp/.hermes/SOUL.md'),
    );

  assert.deepEqual(withoutConfigMount(narrow), withoutConfigMount(focus));
  assert.ok(
    narrow.includes(
      `--mount=type=bind,src=${narrowConfig},dst=/tmp/.hermes/config.yaml,ro`,
    ),
  );
  assert.ok(
    narrow.includes(
      `--mount=type=bind,src=${trustedFocusSoul},dst=/tmp/.hermes/SOUL.md,ro`,
    ),
  );
  assert.ok(narrow.includes('--read-only'));
  assert.ok(narrow.includes('--network=stellar-peon-worker'));
  assert.equal(narrow.includes('--privileged'), false);
  assert.equal(
    narrow.some((argument) => argument.startsWith('--secret=')),
    true,
  );
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

test('passes only a trusted explicit forwarded-request ceiling to the meter', () => {
  const args = buildMeteringProxyArgs({
    name: 'stellar-peon-meter-24-1',
    image,
    uid: 1001,
    gid: 1001,
    maxModelTokens: 32_000,
    maxToolCalls: 64,
    maxForwardedRequests: 2,
  });
  assert.ok(args.includes('--env=STELLAR_MAX_FORWARDED_REQUESTS=2'));
  assert.equal(
    buildMeteringProxyArgs({
      name: 'stellar-peon-meter-24-1',
      image,
      uid: 1001,
      gid: 1001,
      maxModelTokens: 32_000,
      maxToolCalls: 64,
    }).some((argument) =>
      argument.startsWith('--env=STELLAR_MAX_FORWARDED_REQUESTS='),
    ),
    false,
  );
  for (const maxForwardedRequests of [0, 2.5])
    assert.throws(
      () =>
        buildMeteringProxyArgs({
          name: 'stellar-peon-meter-24-1',
          image,
          uid: 1001,
          gid: 1001,
          maxModelTokens: 32_000,
          maxToolCalls: 64,
          maxForwardedRequests,
        }),
      /positive integer/,
    );
  assert.throws(
    () =>
      buildMeteringProxyArgs({
        name: 'stellar-peon-meter-24-1',
        image,
        uid: 1001,
        gid: 1001,
        maxModelTokens: 32_000,
        maxToolCalls: 64,
        maxForwardedRequests: 65,
      }),
    /hard limits/,
  );
});

test('forwards the bounded ceiling without exposing stage-transition controls', () => {
  const args = buildMeteringProxyArgs({
    name: 'stellar-peon-meter-84-1',
    image,
    uid: 1001,
    gid: 1001,
    maxModelTokens: 32_000,
    maxToolCalls: 64,
    maxForwardedRequests: 2,
  });
  assert.ok(args.includes('--env=STELLAR_MAX_FORWARDED_REQUESTS=2'));
  assert.equal(
    args.some((argument) => argument.includes('STELLAR_TWO_STAGE')),
    false,
  );
});

test('rejects a restarted or changed metering-sidecar identity', () => {
  const id = 'd'.repeat(64);
  const identity = { id, startedAt: '2026-10-24T07:00:00Z', restartCount: 0 };
  assert.deepEqual(
    readMeterContainerIdentity(
      'stellar-peon-meter-84-1',
      () => `${id}|2026-10-24T07:00:00Z|0`,
    ),
    { id, startedAt: '2026-10-24T07:00:00Z', restartCount: 0 },
  );
  for (const value of [`${id}|2026-10-24T07:00:00Z|1`, 'invalid'])
    assert.throws(
      () => readMeterContainerIdentity('stellar-peon-meter-84-1', () => value),
      /identity is invalid or was restarted/,
    );
  assert.throws(
    () =>
      assertMeterIdentityUnchanged(
        'stellar-peon-meter-84-1',
        identity,
        () => `${'e'.repeat(64)}|2026-10-24T07:00:00Z|0`,
      ),
    /identity changed during the worker run/,
  );
});

test('live usage polling stays responsive during a slow valid transport read', async () => {
  const identity = {
    id: 'd'.repeat(64),
    startedAt: '2026-10-24T07:00:00Z',
    restartCount: 0,
  };
  let ticks = 0;
  const interval = setInterval(() => {
    ticks += 1;
  }, 10);
  try {
    const usage = await readLiveMeterUsage(
      'stellar-peon-meter-50-1',
      identity,
      {
        execute: async (args) => {
          await new Promise((resolve) => setTimeout(resolve, 70));
          return args[1] === 'inspect'
            ? {
                status: 0,
                output: `${identity.id}|${identity.startedAt}|0|true`,
                reason: null,
              }
            : {
                status: 0,
                output: JSON.stringify({
                  usage: {
                    toolCalls: 1,
                    modelTokens: 0,
                    forwardedRequests: 1,
                    exceededResource: null,
                    requestRecords: [],
                    toolEvents: [
                      {
                        phase: 'pre',
                        callId: 'a'.repeat(24),
                        toolName: 'terminal',
                        argumentBytes: 10,
                        argumentCount: 1,
                      },
                    ],
                  },
                }),
                reason: null,
              };
        },
      },
    );
    assert.equal(usage.forwardedRequests, 1);
    assert.equal(usage.toolEvents[0].toolName, 'terminal');
    assert.ok(ticks >= 5);
  } finally {
    clearInterval(interval);
  }
});

test('live usage polling distinguishes timeout, stopped meter, malformed usage, and cancellation', async () => {
  const identity = {
    id: 'd'.repeat(64),
    startedAt: '2026-10-24T07:00:00Z',
    restartCount: 0,
  };
  const check = async (execute, category, signal) =>
    assert.rejects(
      readLiveMeterUsage('stellar-peon-meter-50-1', identity, {
        execute,
        signal,
      }),
      (error) =>
        error.code === 'UsageAccountingFailure' &&
        error.diagnostic.category === category &&
        error.diagnostic.phase === 'running',
    );
  await check(
    async () => ({ status: null, output: '', reason: 'timeout' }),
    'transport-timeout',
  );
  const laterCancellation = new AbortController();
  await check(
    async () => {
      laterCancellation.abort();
      return { status: null, output: '', reason: 'timeout' };
    },
    'transport-timeout',
    laterCancellation.signal,
  );
  await check(
    async () => ({
      status: 0,
      output: `${identity.id}|${identity.startedAt}|0|false`,
      reason: null,
    }),
    'sidecar-terminated',
  );
  await check(
    async (args) =>
      args[1] === 'inspect'
        ? {
            status: 0,
            output: `${identity.id}|${identity.startedAt}|0|true`,
            reason: null,
          }
        : { status: 0, output: '{broken', reason: null },
    'malformed-response',
  );
  await check(
    async (args) =>
      args[1] === 'inspect'
        ? {
            status: 0,
            output: `${identity.id}|${identity.startedAt}|0|true`,
            reason: null,
          }
        : {
            status: 0,
            output: JSON.stringify({
              usage: {
                toolCalls: 0,
                modelTokens: 0,
                forwardedRequests: 0,
                exceededResource: null,
                requestRecords: [],
                toolEvents: [
                  { phase: 'pre', command: 'raw output must not persist' },
                ],
              },
            }),
            reason: null,
          },
    'invalid-usage',
  );
  const controller = new AbortController();
  controller.abort();
  await check(
    async () => ({ status: null, output: '', reason: 'cancelled' }),
    'poll-cancelled',
    controller.signal,
  );
});

test('waits for a successful usage read from the exact sidecar after health', () => {
  const events = [];
  let time = 0;
  let usageAttempts = 0;
  const usage = {
    toolCalls: 0,
    modelTokens: 0,
    exceededResource: null,
    requestRecords: [],
  };
  const result = waitForMeter('stellar-peon-meter-50-5', {
    now: () => time,
    timeoutMs: 1_000,
    sleep: () => {
      time += 250;
    },
    readHealth: (name) => {
      events.push(`health:${name}`);
      if (events.length < 3) throw new Error('sidecar still starting');
    },
    readUsage: (name, options) => {
      events.push(`usage:${name}:${options.phase}`);
      usageAttempts += 1;
      if (usageAttempts === 1) throw new Error('usage endpoint not ready');
      return usage;
    },
  });

  assert.equal(result, usage);
  assert.deepEqual(events, [
    'health:stellar-peon-meter-50-5',
    'health:stellar-peon-meter-50-5',
    'health:stellar-peon-meter-50-5',
    'usage:stellar-peon-meter-50-5:startup',
    'health:stellar-peon-meter-50-5',
    'usage:stellar-peon-meter-50-5:startup',
  ]);
});

test('bounds meter readiness and reports a sanitized startup timeout', () => {
  let time = 0;
  assert.throws(
    () =>
      waitForMeter('stellar-peon-meter-50-5', {
        now: () => time,
        timeoutMs: 500,
        sleep: () => {
          time += 250;
        },
        readHealth: () => {
          throw new Error('raw output that must not persist');
        },
        readUsage: () => assert.fail('usage must follow healthy sidecar'),
      }),
    (error) => {
      assert.equal(error.code, 'UsageAccountingFailure');
      assert.deepEqual(error.diagnostic, {
        category: 'readiness-timeout',
        phase: 'startup',
        elapsedMs: 500,
      });
      assert.doesNotMatch(error.message, /raw output/);
      return true;
    },
  );
});

test('keeps an unavailable model distinct from a missing usage endpoint during readiness', () => {
  let time = 0;
  assert.throws(
    () =>
      waitForMeter('stellar-peon-meter-50-1', {
        now: () => time,
        timeoutMs: 500,
        sleep: () => {
          time += 250;
        },
        readHealth: () => {
          const error = new Error('upstream details must not persist');
          error.diagnostic = {
            category: 'model-unavailable',
            phase: 'startup',
          };
          throw error;
        },
        readUsage: () =>
          assert.fail('unhealthy model must not produce usage readiness'),
      }),
    (error) =>
      error.diagnostic.category === 'model-unavailable' &&
      error.diagnostic.phase === 'startup' &&
      !error.message.includes('upstream details'),
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

test('scoped verification mounts only task source writable and keeps build output ephemeral', () => {
  const args = buildRestrictedVerificationArgs({
    issueNumber: 50,
    image,
    uid: 1001,
    gid: 1001,
    command: ['corepack', 'pnpm', 'exec', 'nx', 'test', 'ui-atoms'],
    protectedPaths,
    writablePaths: ['libs/ui/atoms/src/lib/atoms'],
  });
  assert.ok(
    args.includes(
      '--mount=type=bind,src=/home/peon/workspaces/issue-50,dst=/workspace,ro',
    ),
  );
  assert.ok(
    args.includes(
      '--mount=type=bind,src=/home/peon/workspaces/issue-50/libs/ui/atoms/src/lib/atoms,dst=/workspace/libs/ui/atoms/src/lib/atoms,rw',
    ),
  );
  assert.ok(
    args.includes(
      '--tmpfs=/workspace/dist:rw,nosuid,nodev,size=512m,mode=1777',
    ),
  );
  assert.ok(
    args.includes('--tmpfs=/workspace/tmp:rw,nosuid,nodev,size=512m,mode=1777'),
  );
  assert.ok(
    args.includes('--env=NX_WORKSPACE_DATA_DIRECTORY=/tmp/nx-workspace-data'),
  );
  assert.equal(
    args.some((argument) => argument.includes('dst=/workspace/.git,rw')),
    false,
  );
  assert.throws(
    () =>
      buildRestrictedVerificationArgs({
        issueNumber: 50,
        image,
        uid: 1001,
        gid: 1001,
        command: ['node', '--test'],
        protectedPaths,
        writablePaths: ['tools/policy'],
      }),
    /trusted writable paths/,
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
        hermesConfigSource: trustedFocusConfig,
        hermesSoulSource: trustedFocusSoul,
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
        hermesConfigSource: trustedFocusConfig,
        hermesSoulSource: trustedFocusSoul,
      }),
    /ghcr\.io\/stellar-ai-corp\/hermes-worker/,
  );
});

test('uses an offline read-only sha256 command for the embedded proxy', () => {
  const args = buildWorkerImageInspectionArgs(image);

  assert.deepEqual(args.slice(0, 2), ['run', '--rm']);
  assert.ok(args.includes('--pull=never'));
  assert.ok(args.includes('--network=none'));
  assert.ok(args.includes('--read-only'));
  assert.ok(args.includes('--entrypoint=/usr/bin/sha256sum'));
  assert.equal(
    args.some((argument) =>
      /GH_TOKEN|STELLAR_INTEGRATION_TOKEN|secret|18436/i.test(argument),
    ),
    false,
  );
  assert.throws(
    () =>
      buildWorkerImageInspectionArgs(
        'ghcr.io/stellar-ai-corp/hermes-worker:latest',
      ),
    /pinned by a lowercase SHA-256 digest/,
  );
});

test('memoizes repeated worker cancellation for one exact attempt', async () => {
  let resolveRun;
  let resolveCancellation;
  let cancellationCalls = 0;
  const adapter = createPeonWorkerAdapter({
    image,
    commandForTask: () => ['hermes', 'chat'],
    runAttempt: () =>
      new Promise((resolve) => {
        resolveRun = resolve;
      }),
    confirmCancellation: async (input) => {
      cancellationCalls += 1;
      assert.equal(input.workerName, 'stellar-peon-worker-50-4');
      assert.equal(input.meterName, 'stellar-peon-meter-50-4');
      return new Promise((resolve) => {
        resolveCancellation = resolve;
      });
    },
  });
  const run = adapter.run({
    task: { issueNumber: 50 },
    attemptNumber: 4,
    limits: { maxRuntimeMsPerWorker: 600_000 },
    budget: { snapshot: { modelTokens: 0, toolCalls: 0 } },
  });
  await Promise.resolve();

  const first = adapter.cancel();
  const second = adapter.cancel();
  assert.equal(first, second);
  assert.equal(cancellationCalls, 1);
  resolveCancellation({ confirmed: true });
  assert.equal(await first, true);
  resolveRun({ exitCode: 0, usage: { modelTokens: 0, toolCalls: 0 } });
  await run;
  assert.equal(await adapter.cancel(), true);
  assert.equal(cancellationCalls, 1);
});

test('passes only the validated profile through the adapter and fails mismatches closed', async () => {
  let selectedProfile;
  let selectedRequestLimit;
  const adapter = createPeonWorkerAdapter({
    image,
    hermesProfile: 'narrow-coding',
    maxForwardedRequests: 2,
    commandForTask: () => ['hermes', 'chat'],
    runAttempt: async (input) => {
      selectedProfile = input.hermesProfile;
      selectedRequestLimit = input.maxForwardedRequests;
      return { exitCode: 0, usage: { modelTokens: 0, toolCalls: 0 } };
    },
  });
  await assert.rejects(
    adapter.run({
      task: { issueNumber: 50 },
      attemptNumber: 1,
      limits: { maxRuntimeMsPerWorker: 600_000 },
      budget: { snapshot: { modelTokens: 0, toolCalls: 0 } },
    }),
    /profile differs from the validated issue/,
  );
  const run = adapter.run({
    task: {
      issueNumber: 50,
      hermesProfile: 'narrow-coding',
      maxForwardedRequests: 99,
    },
    attemptNumber: 2,
    limits: { maxRuntimeMsPerWorker: 600_000 },
    budget: { snapshot: { modelTokens: 0, toolCalls: 0 } },
  });
  assert.equal((await run).status, 'completed');
  assert.equal(selectedProfile, 'narrow-coding');
  assert.equal(selectedRequestLimit, 2);
  assert.equal(defaultPeonHermesProfile, 'focus');
  assert.equal(
    peonHermesConfigFilename('narrow-coding'),
    'peon-hermes-narrow-config.yaml',
  );
});

test('adapter publishes usage readiness only after launcher confirmation', async () => {
  let sidecarAvailable = false;
  let inferenceStarted = false;
  const adapter = createPeonWorkerAdapter({
    image,
    commandForTask: () => ['hermes', 'chat'],
    runAttempt: async ({ onUsageReady }) => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      sidecarAvailable = true;
      onUsageReady();
      inferenceStarted = true;
      await new Promise((resolve) => setTimeout(resolve, 120));
      return {
        exitCode: 1,
        usage: { modelTokens: 0, toolCalls: 0, requestRecords: [] },
      };
    },
    readUsage: async (name) => {
      assert.equal(name, 'stellar-peon-meter-50-5');
      assert.equal(sidecarAvailable, true);
      assert.equal(inferenceStarted, true);
      return { modelTokens: 0, toolCalls: 0, requestRecords: [] };
    },
    confirmCancellation: async () => true,
  });
  const run = adapter.run({
    task: { issueNumber: 50 },
    attemptNumber: 5,
    limits: { maxRuntimeMsPerWorker: 600_000 },
    budget: { snapshot: { modelTokens: 0, toolCalls: 0 } },
  });

  await adapter.waitForUsageReady();
  const snapshot = await adapter.usage();
  assert.deepEqual(snapshot, {
    modelTokens: 0,
    toolCalls: 0,
    requestRecords: [],
  });
  assert.equal((await run).status, 'failed');
  assert.deepEqual(await adapter.usage(), {
    modelTokens: 0,
    toolCalls: 0,
    requestRecords: [],
  });
});

test('restricted verification cancellation confirms only its exact attempt', async () => {
  const inspected = [];
  let stopCalled = false;
  const confirmed = await cancelRestrictedVerification({
    issueNumber: 50,
    attemptNumber: 91,
    containerOperations: {
      inspect: async (name) => {
        inspected.push(name);
        return 'absent';
      },
      stop: async () => {
        stopCalled = true;
        return false;
      },
    },
  });

  assert.equal(confirmed, true);
  assert.deepEqual(inspected, ['stellar-peon-verify-50-91']);
  assert.equal(stopCalled, false);
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
        hermesConfigSource: trustedFocusConfig,
        hermesSoulSource: trustedFocusSoul,
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
        protectedPaths,
        hermesConfigSource: trustedFocusConfig,
        hermesSoulSource: trustedFocusSoul,
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
    hermesConfigSource: trustedFocusConfig,
    hermesSoulSource: trustedFocusSoul,
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
    hermesConfigSource: trustedFocusConfig,
    hermesSoulSource: trustedFocusSoul,
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

test('prepared context transport is interactive, read-only inspectable, and does not use a host-sized prompt argument', () => {
  const args = buildPodmanArgs({
    issueNumber: 50,
    image,
    uid: 1001,
    gid: 1001,
    protectedPaths,
    command: ['python3', '-c', 'read stdin'],
    hermesConfigSource: trustedFocusConfig,
    hermesSoulSource: trustedFocusSoul,
    interactive: true,
  });
  assert.ok(args.includes('--interactive'));

  const inspect = buildHermesPromptInspectionArgs({
    image,
    uid: 1001,
    gid: 1001,
    workspace: '/home/peon/workspaces/issue-50',
    hermesConfigSource: trustedFocusConfig,
    hermesSoulSource: trustedFocusSoul,
    inspectionScriptSource:
      '/mnt/d/ai-repositories/stellar/tools/policy/inspect-hermes-system-prompt.py',
    runnerScriptSource:
      '/mnt/d/ai-repositories/stellar/tools/policy/run-hermes-system-prompt-inspection.sh',
  });
  assert.ok(inspect.includes('--network=none'));
  assert.ok(inspect.includes('--read-only'));
  assert.ok(inspect.includes('--cap-drop=all'));
  assert.ok(
    inspect.includes(
      '--mount=type=bind,src=/home/peon/workspaces/issue-50,dst=/workspace,ro',
    ),
  );
  assert.ok(
    inspect.includes(
      `--mount=type=bind,src=${trustedFocusSoul},dst=/tmp/.hermes/SOUL.md,ro`,
    ),
  );
  assert.ok(
    inspect.includes(
      '--mount=type=bind,src=/mnt/d/ai-repositories/stellar/tools/policy/run-hermes-system-prompt-inspection.sh,dst=/usr/local/libexec/verify-hermes-runtime.py,ro',
    ),
  );
  assert.ok(!inspect.some((argument) => argument.startsWith('--secret=')));
  assert.ok(!inspect.some((argument) => argument.includes('OPENAI_API_KEY')));
  assert.throws(
    () =>
      buildHermesPromptInspectionArgs({
        image,
        uid: 1001,
        gid: 1001,
        workspace: '/home/peon/workspaces/issue-50',
        hermesConfigSource: trustedFocusConfig,
        inspectionScriptSource: '/tmp/inspector.py',
        runnerScriptSource: '/tmp/runner.sh',
      }),
    /trusted absolute mount paths/,
  );
  assert.throws(
    () =>
      buildHermesPromptInspectionArgs({
        image,
        uid: 1001,
        gid: 1001,
        workspace: '/home/peon/workspaces/issue-50',
        hermesConfigSource: trustedFocusConfig,
        hermesSoulSource: trustedFocusSoul,
        inspectionScriptSource: '/tmp/bad,source.py',
        runnerScriptSource: '/tmp/runner.sh',
      }),
    /trusted absolute mount paths/,
  );
});

test('pinned prompt matcher accepts only Hermes newline normalization', () => {
  const source = readFileSync(
    new URL('./inspect-hermes-system-prompt.py', import.meta.url),
    'utf8',
  );
  const python = `import ast, json, sys
tree = ast.parse(sys.stdin.read())
matcher = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'embedded_copy_count')
scope = {}
exec(compile(ast.Module(body=[matcher], type_ignores=[]), '<trusted-matcher>', 'exec'), scope)
count = scope['embedded_copy_count']
print(json.dumps([
    count('first\\nsecond\\n', 'first\\r\\nsecond\\r\\n'),
    count('first\\nsecond\\n', 'first\\r\\nchanged\\r\\n'),
    count('first\\nsecond\\nfirst\\nsecond\\n', 'first\\r\\nsecond\\r\\n'),
    count('one line', 'one line\\r\\n', True),
    count('one line', '', True),
]))`;
  const windows = process.platform === 'win32';
  const run = spawnSync(
    windows ? 'wsl.exe' : 'python3',
    [
      ...(windows
        ? ['--distribution', 'Ubuntu', '--user', 'peon', '--exec', 'python3']
        : []),
      '-c',
      python,
    ],
    { input: source, encoding: 'utf8', windowsHide: true, timeout: 10_000 },
  );
  assert.equal(run.status, 0, 'trusted Python matcher must run');
  assert.deepEqual(JSON.parse(run.stdout), [1, 0, 2, 1, 0]);
});

test('prompt inspection failures report bounded categories without raw output', () => {
  const examples = [
    [
      {
        status: 1,
        stderr:
          'Hermes system prompt did not contain one exact copy. secret=private',
      },
      'attestation',
      'content-mismatch',
    ],
    [
      { status: 125, stderr: 'Error: statfs mount failed' },
      'mounts',
      'mount-failure',
    ],
    [
      { status: 1, stderr: 'Traceback: ModuleNotFoundError' },
      'hermes',
      'initialization-failure',
    ],
    [{ status: 137, stderr: 'killed' }, 'container', 'resource-exhaustion'],
    [{ status: null, error: { code: 'ETIMEDOUT' } }, 'container', 'timeout'],
    [{ status: 1, stderr: 'secret=private' }, 'inspection', 'unknown-failure'],
  ];
  for (const [result, stage, category] of examples) {
    const error = classifyHermesPromptInspectionFailure(result);
    assert.equal(error.stage, stage);
    assert.equal(error.exitStatus, result.status);
    assert.equal(error.category, category);
    assert.doesNotMatch(error.message, /private|Traceback|statfs/);
  }
});

test('rejects oversized or NUL-containing prepared input before launcher preflight', async () => {
  await assert.rejects(
    runRestrictedWorker({ issueNumber: 50, taskInput: 'x'.repeat(52_001) }),
    /Prepared task input is invalid or exceeds its trusted size limit/,
  );
  await assert.rejects(
    runRestrictedWorker({ issueNumber: 50, taskInput: 'bad\0input' }),
    /Prepared task input is invalid or exceeds its trusted size limit/,
  );
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
