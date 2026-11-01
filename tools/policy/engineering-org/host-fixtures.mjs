import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultLimits } from '../supervise-worker.mjs';
import {
  createRepositoryAdmission,
  repositoryIssueDigest,
} from './host-context.mjs';
import { createEngineeringHost } from './host-engine.mjs';
import { inertRecipe } from './host-session.mjs';
import { digest } from './planning-evidence.mjs';

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export async function createHostFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'stellar-host-'));
  const repositoryRoot = path.join(root, 'repository');
  const worktree = path.join(root, 'worker');
  await mkdir(repositoryRoot);
  git(repositoryRoot, 'init', '-b', 'develop');
  git(repositoryRoot, 'config', 'core.autocrlf', 'false');
  await writeFile(
    path.join(repositoryRoot, 'widget.mjs'),
    'export const value = 1;\n',
  );
  git(repositoryRoot, 'add', 'widget.mjs');
  git(
    repositoryRoot,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'core.hooksPath=',
    'commit',
    '-m',
    'Inert fixture source',
  );
  const revision = git(repositoryRoot, 'rev-parse', 'HEAD');
  git(
    repositoryRoot,
    'worktree',
    'add',
    '-b',
    'issue/42-small-widget',
    worktree,
  );
  const request = {
    issueNumber: 42,
    sessionId: 'inert-claim-42',
    key: 'first-run',
  };
  const issue = {
    number: 42,
    title: 'Repair small widget',
    state: 'OPEN',
    body: '## Objective\nRepair widget.\n## Context\nWidget is broken.\n## Expected outcome\nWidget works.\n## Acceptance criteria\n- [ ] Widget returns the required value.\n## Constraints\nStay scoped.\n## Dependencies\nNone\n## Verification expectations\nRun the fixture probe.',
    labels: [
      'priority:low',
      'review:standard',
      'type:bug',
      'target:develop',
      'status:in-progress',
      'worker:peon',
    ],
    dependencies: [],
  };
  const claim = {
    issue: 42,
    state: 'active',
    worker: 'worker:peon',
    sessionId: request.sessionId,
    target: 'develop',
    branch: 'issue/42-small-widget',
    worktreePath: worktree,
    expiresAt: '2099-01-01T00:00:00.000Z',
  };
  const claimRoot = path.join(
    repositoryRoot,
    '.git',
    'stellar-agent',
    'claims',
  );
  await mkdir(claimRoot, { recursive: true });
  await writeFile(path.join(claimRoot, '42.json'), JSON.stringify(claim));
  const scope = {
    schemaVersion: 1,
    repository: 'DanielssonThomas/Stellar',
    issueNumber: 42,
    sessionId: request.sessionId,
    sourceRevision: revision,
    policyRevision: revision,
    issueDigest: repositoryIssueDigest(issue),
    scope: {
      complexity: 'small',
      ambiguous: false,
      riskFloor: 'standard',
      files: [{ filename: 'widget.mjs', status: 'modified' }],
      requiredSkills: ['widget'],
      criteria: [
        { id: 'value', description: 'Widget returns the required value.' },
      ],
    },
    evidence: [
      {
        id: 'inert-capability',
        worker: 'peon',
        skill: 'widget',
        outcome: 'passed',
        revision,
        artifact: 'fixture/verification.json',
        source: 'host-verified-attempt',
        completedAt: '2026-10-31T12:00:00.000Z',
      },
    ],
    authorizedWorkers: ['peon'],
    limits: { ...defaultLimits, maxAttemptsPerWorker: 1 },
  };
  const scopeRecordPath = path.join(root, 'scope.json');
  await writeFile(scopeRecordPath, JSON.stringify(scope));
  const options = {
    repositoryRoot,
    scopeRecordPath,
    scopeRecordDigest: digest(scope),
    hostReaders: {
      loadIssue: async () => issue,
      resolveDevelopHead: async () => revision,
      now: () => '2026-11-01T12:00:00.000Z',
    },
  };
  const recipes = Object.fromEntries(
    await Promise.all(
      ['dispatch', 'implement', 'verify', 'review', 'reconcile'].map(
        async (phase) => [phase, await inertRecipe(phase)],
      ),
    ),
  );
  const hostOptions = {
    admission: createRepositoryAdmission(options),
    storeRoot: path.join(root, 'host'),
    poolRoot: path.join(root, 'pool'),
    recipes,
  };
  return {
    root,
    repositoryRoot,
    worktree,
    issue,
    claim,
    request,
    options,
    hostOptions,
    host: await createEngineeringHost(hostOptions),
  };
}
