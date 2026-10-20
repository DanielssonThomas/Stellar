import assert from 'node:assert/strict';
import { describe, it, test } from 'node:test';
import { parseCommitMessages, validatePrepareState } from './prepare-pr.mjs';

const issue = {
  number: 20,
  body: `## Objective\nPrepare PRs.\n\n## Expected outcome\nA valid PR.\n\n## Acceptance criteria\n- [ ] Verify state.\n\n## Constraints\nNo merging.\n\n## Dependencies\nNone\n\n## Verification expectations\nRun checks.`,
  state: 'OPEN',
  labels: [
    'priority:high',
    'target:develop',
    'type:chore',
    'status:in-progress',
    'owner:codex',
  ],
  dependencies: [],
};
const base = {
  issue,
  worker: 'codex',
  branch: 'issue/20-prepare-pr',
  status: '',
  claim: {
    state: 'active',
    worker: 'owner:codex',
    issue: 20,
    branch: 'issue/20-prepare-pr',
    target: 'develop',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    worktreePath: process.cwd(),
  },
  commits: ['[#20] feat(pr): validate issue pull request preparation'],
  worktreePath: process.cwd(),
};

test('parses NUL-delimited Git commit messages with separator whitespace', () => {
  const output = [
    `${base.commits[0]}\n\0`,
    '\n[#20] fix(pr): accept every valid linked commit\n\0',
    '\n',
  ].join('');

  assert.deepEqual(parseCommitMessages(output), [
    base.commits[0],
    '[#20] fix(pr): accept every valid linked commit',
  ]);
  assert.equal(
    validatePrepareState({ ...base, commits: parseCommitMessages(output) })
      .valid,
    true,
  );
});

describe('prepare PR preflight', () => {
  it('accepts a clean issue-owned branch with valid linked commits and claim', () => {
    assert.equal(validatePrepareState(base).valid, true);
  });

  it('rejects wrong owner, target, branch, dirty state, missing claim, and unrelated commits', () => {
    const cases = [
      [
        {
          ...issue,
          labels: [...issue.labels.slice(0, -1), 'owner:maintainer'],
        },
        /owner/,
      ],
      [
        {
          ...issue,
          labels: [
            ...issue.labels.slice(0, 1),
            'target:main',
            ...issue.labels.slice(2),
          ],
        },
        /target/,
      ],
    ];
    for (const [changedIssue, expected] of cases)
      assert.ok(
        validatePrepareState({ ...base, issue: changedIssue }).errors.some(
          (error) => expected.test(error),
        ),
      );
    assert.equal(
      validatePrepareState({ ...base, branch: 'develop' }).valid,
      false,
    );
    assert.equal(
      validatePrepareState({ ...base, status: ' M file.ts' }).valid,
      false,
    );
    assert.equal(validatePrepareState({ ...base, claim: null }).valid, false);
    assert.equal(
      validatePrepareState({
        ...base,
        commits: ['[#19] fix: wrong issue commit'],
      }).valid,
      false,
    );
    assert.equal(
      validatePrepareState({ ...base, now: Date.now() + 120_000 }).valid,
      false,
    );
    assert.equal(
      validatePrepareState({
        ...base,
        claim: { ...base.claim, target: 'main' },
      }).valid,
      false,
    );
    assert.equal(
      validatePrepareState({ ...base, worktreePath: `${process.cwd()}-other` })
        .valid,
      false,
    );
  });
});
