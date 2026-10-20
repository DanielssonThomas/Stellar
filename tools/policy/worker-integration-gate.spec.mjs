import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { describe, it } from 'node:test';
import os from 'node:os';
import path from 'node:path';
import {
  evaluateWorkerPullRequest,
  parseIntegrationScope,
  parseProtectedCodeowners,
} from './worker-integration-gate.mjs';

const headSha = 'a'.repeat(40);
const codeowners = `
/.agents/skills/ @DanielssonThomas
/.github/CODEOWNERS @DanielssonThomas
/.github/workflows/ @DanielssonThomas
/.husky/ @DanielssonThomas
/AGENTS.md @DanielssonThomas
/commitlint.config.cjs @DanielssonThomas
/docs/documentation-policy.md @DanielssonThomas
/docs/guides/agent-supervision.md @DanielssonThomas
/docs/guides/worker-integration-policy.md @DanielssonThomas
/docs/guides/worker-security.md @DanielssonThomas
/eslint.config.mjs @DanielssonThomas
/nx.json @DanielssonThomas
/tools/generators/ @DanielssonThomas
/tools/policy/ @DanielssonThomas
`;

const modified = (filename) => ({ status: 'modified', filename });

function validInput() {
  return {
    issue: {
      number: 123,
      state: 'open',
      body: `## Objective\nAdd a small component test.\n\n## Context\nA targeted task.\n\n## Expected outcome\nOne checked change.\n\n## Acceptance criteria\n- [ ] Add the component test.\n\n## Constraints\nStay in the assigned scope.\n\n## Dependencies\n#45\n\n## Agent integration scope\nRisk: low\nAllowed files:\n- \`libs/ui/atoms/src/lib/example.spec.ts\`\n\n## Verification expectations\nRun the focused test.`,
      labels: [
        'priority:medium',
        'target:develop',
        'type:feature',
        'status:review',
        'worker:peon',
        'agent:automerge',
      ],
      dependencies: [{ number: 45, state: 'closed', labels: ['status:done'] }],
    },
    pullRequest: {
      number: 222,
      state: 'open',
      isDraft: false,
      body: 'Implements the task. Fixes #123.',
      baseRefName: 'develop',
      headRefName: 'issue/123-add-component-test',
      headRepoFullName: 'stellar-workers/Stellar',
      authorLogin: 'peon-pr[bot]',
      headSha,
    },
    worker: {
      id: 'peon',
      forkFullName: 'stellar-workers/Stellar',
      pullRequestActor: 'peon-pr[bot]',
    },
    authorizedWorkerIds: ['peon'],
    commits: ['[#123] test(atom): cover the component state'],
    checks: [{ name: 'verify', headSha, conclusion: 'success' }],
    changedFiles: [modified('libs/ui/atoms/src/lib/example.spec.ts')],
    codeowners,
    requiredChecks: ['verify'],
    allowedTargets: ['develop'],
  };
}

function evaluate(change) {
  return evaluateWorkerPullRequest({ ...validInput(), ...change });
}

describe('worker integration gate', () => {
  it('accepts a complete low-risk worker PR with exact-head verification', () => {
    assert.deepEqual(evaluate({}), {
      eligible: true,
      issue: 123,
      pullRequest: 222,
      headSha,
      reasons: [],
    });
  });

  it('parses a trusted low-risk scope with exact allowed files', () => {
    const scope = parseIntegrationScope(validInput().issue.body);
    assert.deepEqual(scope, {
      risk: 'low',
      allowedFiles: ['libs/ui/atoms/src/lib/example.spec.ts'],
      valid: true,
    });
  });

  it('parses the repository CODEOWNERS policy from the current checkout', () => {
    const contents = readFileSync(
      new URL('../../.github/CODEOWNERS', import.meta.url),
      'utf8',
    );
    assert.equal(parseProtectedCodeowners(contents).valid, true);
  });

  it('rejects invalid issue metadata, owner, and missing integration authorization', () => {
    const wrongOwner = validInput();
    wrongOwner.issue.labels = wrongOwner.issue.labels.map((label) =>
      label === 'worker:peon' ? 'worker:mira' : label,
    );
    assert.ok(
      evaluate({ issue: wrongOwner.issue }).reasons.includes(
        'issue-owner-mismatch',
      ),
    );

    const noAuthorization = validInput();
    noAuthorization.issue.labels = noAuthorization.issue.labels.filter(
      (label) => label !== 'agent:automerge',
    );
    assert.ok(
      evaluate({ issue: noAuthorization.issue }).reasons.includes(
        'issue-not-approved-for-integration',
      ),
    );

    assert.ok(
      evaluate({ authorizedWorkerIds: [] }).reasons.includes(
        'invalid-issue-metadata',
      ),
    );
  });

  it('rejects a mismatched fork, PR actor, base, branch, or issue link', () => {
    const input = validInput();
    assert.ok(
      evaluate({
        pullRequest: {
          ...input.pullRequest,
          headRepoFullName: 'other/Stellar',
        },
      }).reasons.includes('worker-fork-mismatch'),
    );
    assert.ok(
      evaluate({
        pullRequest: { ...input.pullRequest, authorLogin: 'someone-else' },
      }).reasons.includes('worker-identity-mismatch'),
    );
    assert.ok(
      evaluate({
        pullRequest: { ...input.pullRequest, baseRefName: 'main' },
      }).reasons.includes('pull-request-target-or-head-invalid'),
    );
    assert.ok(
      evaluate({
        pullRequest: { ...input.pullRequest, headRefName: 'feature/123-test' },
      }).reasons.includes('issue-branch-mismatch'),
    );
    assert.ok(
      evaluate({
        pullRequest: { ...input.pullRequest, body: 'No issue link.' },
      }).reasons.includes('pull-request-does-not-link-issue'),
    );
  });

  it('accepts the trusted runner as PR author when it creates the cross-fork PR', () => {
    const input = validInput();
    assert.equal(
      evaluateWorkerPullRequest({
        ...input,
        integrationActor: 'stellar-integration[bot]',
        pullRequest: {
          ...input.pullRequest,
          authorLogin: 'stellar-integration[bot]',
        },
      }).eligible,
      true,
    );
    assert.ok(
      evaluateWorkerPullRequest({
        ...input,
        integrationActor: 'stellar-integration[bot]',
        pullRequest: { ...input.pullRequest, authorLogin: 'untrusted-user' },
      }).reasons.includes('integration-identity-mismatch'),
    );
  });

  it('rejects missing, failed, pending, or stale required check evidence', () => {
    assert.ok(
      evaluate({ checks: [] }).reasons.includes(
        'required-check-missing-failed-or-stale',
      ),
    );
    for (const conclusion of ['failure', 'null']) {
      assert.ok(
        evaluate({
          checks: [{ name: 'verify', headSha, conclusion }],
        }).reasons.includes('required-check-missing-failed-or-stale'),
      );
    }
    assert.ok(
      evaluate({
        checks: [
          { name: 'verify', headSha: 'b'.repeat(40), conclusion: 'success' },
        ],
      }).reasons.includes('required-check-missing-failed-or-stale'),
    );
  });

  it('rejects malformed, unrelated, and duplicate commits', () => {
    assert.ok(
      evaluate({ commits: ['update files'] }).reasons.includes(
        'issue-commit-invalid',
      ),
    );
    assert.ok(
      evaluate({
        commits: ['[#122] fix(scope): repair the component test'],
      }).reasons.includes('issue-commit-invalid'),
    );
    assert.ok(
      evaluate({ commits: [] }).reasons.includes('commit-list-invalid'),
    );
  });

  it('rejects unresolved or mismatched native dependencies', () => {
    const input = validInput();
    assert.ok(
      evaluate({
        issue: {
          ...input.issue,
          dependencies: [
            { number: 45, state: 'OPEN', labels: ['status:in-progress'] },
          ],
        },
      }).reasons.includes('unresolved-dependency'),
    );
    assert.ok(
      evaluate({
        issue: { ...input.issue, dependencies: [] },
      }).reasons.includes('dependency-record-mismatch'),
    );
  });

  it('rejects files outside the exact trusted scope and protected governance paths', () => {
    assert.ok(
      evaluate({
        changedFiles: [modified('libs/ui/atoms/src/lib/other.ts')],
      }).reasons.includes('changed-file-outside-trusted-scope'),
    );
    const protectedInput = validInput();
    protectedInput.issue.body = protectedInput.issue.body.replace(
      'libs/ui/atoms/src/lib/example.spec.ts',
      'tools/policy/worker-integration-gate.mjs',
    );
    assert.ok(
      evaluate({
        issue: protectedInput.issue,
        changedFiles: [modified('tools/policy/worker-integration-gate.mjs')],
      }).reasons.includes('protected-path-changed'),
    );
  });

  it('rejects a protected path renamed into an otherwise allowed path', () => {
    const input = validInput();
    input.issue.body = input.issue.body.replace(
      'libs/ui/atoms/src/lib/example.spec.ts',
      'libs/ui/atoms/src/lib/renamed.ts',
    );
    const result = evaluate({
      issue: input.issue,
      changedFiles: [
        {
          status: 'renamed',
          filename: 'libs/ui/atoms/src/lib/renamed.ts',
          previous_filename: 'tools/policy/worker-integration-gate.mjs',
        },
      ],
    });
    assert.ok(result.reasons.includes('protected-path-changed'));
  });

  it('rejects protected content staged through an alternate Git index operation', () => {
    const directory = mkdtempSync(
      path.join(os.tmpdir(), 'stellar-worker-protected-index-'),
    );
    const runGit = (args, input) =>
      execFileSync('git', args, {
        cwd: directory,
        encoding: 'utf8',
        ...(input === undefined ? {} : { input }),
      }).trim();

    try {
      mkdirSync(path.join(directory, 'tools', 'policy'), { recursive: true });
      writeFileSync(
        path.join(directory, 'tools', 'policy', 'evaluator.mjs'),
        'trusted evaluator\n',
      );
      runGit(['init', '-q']);
      runGit(['config', 'user.name', 'Security Test']);
      runGit(['config', 'user.email', 'security-test@example.invalid']);
      runGit(['add', '.']);
      runGit(['commit', '-qm', 'baseline']);

      const maliciousBlob = runGit(
        ['hash-object', '-w', '--stdin'],
        'tampered evaluator content\n',
      );
      runGit([
        'update-index',
        '--cacheinfo',
        '100644',
        maliciousBlob,
        'tools/policy/evaluator.mjs',
      ]);
      const [status, filename] = runGit([
        'diff',
        '--cached',
        '--name-status',
      ]).split('\t');
      const result = evaluate({
        changedFiles: [
          { status: status === 'M' ? 'modified' : status, filename },
        ],
      });

      assert.equal(filename, 'tools/policy/evaluator.mjs');
      assert.ok(result.reasons.includes('protected-path-changed'));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects rename evidence without the previous filename', () => {
    const result = evaluate({
      changedFiles: [
        { status: 'renamed', filename: 'libs/ui/atoms/src/lib/renamed.ts' },
      ],
    });
    assert.ok(result.reasons.includes('changed-file-list-invalid'));
  });

  it('rejects case variants of protected paths', () => {
    assert.ok(
      evaluate({
        changedFiles: [modified('TOOLS/POLICY/worker-integration-gate.mjs')],
      }).reasons.includes('protected-path-changed'),
    );
  });

  it('rejects supervisor and worker security policy changes', () => {
    for (const filename of [
      'docs/guides/agent-supervision.md',
      'docs/guides/worker-integration-policy.md',
      'docs/guides/worker-security.md',
    ]) {
      assert.ok(
        evaluate({ changedFiles: [modified(filename)] }).reasons.includes(
          'protected-path-changed',
        ),
      );
    }
  });

  it('requires a completed dependency status, not just a closed state', () => {
    const input = validInput();
    assert.ok(
      evaluate({
        issue: {
          ...input.issue,
          dependencies: [{ number: 45, state: 'CLOSED', labels: [] }],
        },
      }).reasons.includes('unresolved-dependency'),
    );
  });

  it('fails closed on invalid CODEOWNERS and malformed changed paths', () => {
    assert.equal(parseProtectedCodeowners('/tools/** @owner').valid, false);
    assert.ok(
      evaluate({ codeowners: '' }).reasons.includes(
        'protected-path-policy-invalid',
      ),
    );
    assert.ok(
      evaluate({ changedFiles: [modified('../AGENTS.md')] }).reasons.includes(
        'changed-file-list-invalid',
      ),
    );
    assert.ok(
      evaluate({
        changedFiles: ['libs/ui/atoms/src/lib/example.spec.ts'],
      }).reasons.includes('changed-file-list-invalid'),
    );
  });

  it('returns a denial instead of throwing on malformed or missing inputs', () => {
    const result = evaluateWorkerPullRequest({
      issue: {
        number: 'invalid',
        labels: [null],
        body: null,
        dependencies: [null],
      },
      pullRequest: { state: 'OPEN', number: 'bad' },
      worker: null,
      authorizedWorkerIds: null,
      commits: null,
      checks: [null],
      changedFiles: null,
      codeowners: null,
      requiredChecks: null,
      allowedTargets: null,
    });
    assert.equal(result.eligible, false);
    assert.ok(result.reasons.length > 0);
  });

  it('rejects draft PRs and malformed or absent low-risk scopes', () => {
    const input = validInput();
    assert.ok(
      evaluate({
        pullRequest: { ...input.pullRequest, isDraft: true },
      }).reasons.includes('pull-request-not-open-ready'),
    );
    assert.ok(
      evaluate({
        issue: {
          ...input.issue,
          body: input.issue.body.replace('Risk: low', 'Risk: high'),
        },
      }).reasons.includes('trusted-low-risk-scope-invalid'),
    );
    assert.ok(
      evaluate({
        issue: {
          ...input.issue,
          body: input.issue.body.replace(
            /Allowed files:[\s\S]*?## Verification expectations/,
            'Allowed files:\n\n## Verification expectations',
          ),
        },
      }).reasons.includes('trusted-low-risk-scope-invalid'),
    );
    assert.equal(
      parseIntegrationScope(
        input.issue.body +
          '\n\n## Agent integration scope\nRisk: low\nAllowed files:\n- `another.ts`',
      ).valid,
      false,
    );
  });
});
