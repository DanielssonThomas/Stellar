import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
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
/eslint.config.mjs @DanielssonThomas
/nx.json @DanielssonThomas
/tools/generators/ @DanielssonThomas
/tools/policy/ @DanielssonThomas
`;

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
    changedFiles: ['libs/ui/atoms/src/lib/example.spec.ts'],
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

  it('parses the repository CODEOWNERS policy from the current checkout', async () => {
    const contents = await readFile(
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
        changedFiles: ['libs/ui/atoms/src/lib/other.ts'],
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
        changedFiles: ['tools/policy/worker-integration-gate.mjs'],
      }).reasons.includes('protected-path-changed'),
    );
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
      evaluate({ changedFiles: ['../AGENTS.md'] }).reasons.includes(
        'changed-file-list-invalid',
      ),
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
