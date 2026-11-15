import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  admitBudgetRevisions,
  lastPreBudgetIssue,
  readIssueBudget,
} from './issue-budget.mjs';
import { validateIssue } from './validate-issue.mjs';

const body = `## Objective\nAdd an example capability.\n\n## Expected outcome\nThe behavior is observable.\n\n## Acceptance criteria\n- [ ] A user can verify the result.\n\n## Constraints\nKeep changes within shared libraries.\n\n## Dependencies\nNone\n\n## Verification expectations\nRun the affected unit test.`;

function issue(labels) {
  return { number: 42, body, labels: labels.map((name) => ({ name })) };
}

const firstEstimate = {
  revision: 1,
  recordedAt: '2026-11-11T08:00:00Z',
  estimatedTokens: 42000,
  allocatedTokens: 60000,
  profile: 'Codex Sol medium with an independent review',
  confidence: 'medium',
  evidence: ['#300'],
};

function budgetSection(
  contract = { schemaVersion: 1, revisions: [firstEstimate] },
) {
  return (
    '\n\n## Development budget\n\n```json\n' +
    JSON.stringify(contract) +
    '\n```\n'
  );
}

function newIssue(overrides = {}) {
  return {
    number: lastPreBudgetIssue + 1,
    body,
    labels: [
      'priority:medium',
      'review:standard',
      'target:develop',
      'type:feature',
      'owner:codex',
      'status:ready',
    ],
    ...overrides,
  };
}

describe('development budget policy', () => {
  it('requires a budget for new issues and drafts at readiness', () => {
    for (const number of [lastPreBudgetIssue + 1, undefined]) {
      assert.equal(validateIssue(newIssue({ number })).ready, false);
      assert.equal(
        validateIssue(newIssue({ number, body: body + budgetSection() })).ready,
        true,
      );
    }
    assert.deepEqual(
      validateIssue(
        newIssue({
          body: body + budgetSection(null),
          labels: ['status:triage'],
        }),
      ),
      { valid: true, ready: false, errors: [] },
    );
  });

  it('grandfathers existing issues and checks a budget when supplied', () => {
    const historical = newIssue({
      number: lastPreBudgetIssue,
      labels: newIssue().labels.map((label) =>
        label === 'status:ready' ? 'status:in-progress' : label,
      ),
    });
    assert.equal(validateIssue(historical).valid, true);
    assert.equal(
      validateIssue({ ...historical, body: body + budgetSection(null) }).valid,
      false,
    );
  });

  it('preserves the original estimate when another revision is appended', () => {
    const revised = {
      ...firstEstimate,
      revision: 2,
      recordedAt: '2026-11-11T09:00:00.142Z',
      estimatedTokens: 54000,
      allocatedTokens: 50000,
      confidence: 'low',
    };
    const original = readIssueBudget(body + budgetSection());
    const current = readIssueBudget(
      body +
        budgetSection({
          schemaVersion: 1,
          revisions: [firstEstimate, revised],
        }),
    );
    assert.deepEqual(current.revisions, [
      { ...firstEstimate, recordedAt: '2026-11-11T08:00:00.000Z' },
      revised,
    ]);
    assert.deepEqual(current.revisions[0], original.revisions[0]);
  });

  it('rejects malformed or ambiguous contracts without returning issue text', () => {
    const invalid = [
      { revision: 2 },
      { recordedAt: '2026-02-30T08:00:00Z' },
      { recordedAt: '2026-11-11T10:00:00+02:00' },
      { estimatedTokens: '42000' },
      { allocatedTokens: 1.5 },
      { allocatedTokens: 0 },
      { estimatedTokens: Number.MAX_SAFE_INTEGER + 1 },
      { profile: ' ' },
      { confidence: 'unknown' },
      { evidence: ['\n'] },
    ];
    for (const override of invalid) {
      const candidate = newIssue({
        body:
          body +
          budgetSection({
            schemaVersion: 1,
            revisions: [{ ...firstEstimate, ...override }],
          }),
      });
      assert.equal(
        validateIssue(candidate).valid,
        false,
        JSON.stringify(override),
      );
    }
    assert.throws(
      () => readIssueBudget(budgetSection() + budgetSection()),
      /exactly one/,
    );
    assert.throws(
      () =>
        readIssueBudget(
          budgetSection().replace(
            JSON.stringify({
              schemaVersion: 1,
              revisions: [firstEstimate],
            }),
            'untrusted-marker',
          ),
        ),
      { message: 'Development budget must contain valid JSON.' },
    );
    assert.throws(
      () =>
        readIssueBudget(
          budgetSection({
            schemaVersion: 1,
            revisions: [
              firstEstimate,
              {
                ...firstEstimate,
                revision: 2,
                recordedAt: '2026-11-10T08:00:00Z',
              },
            ],
          }),
        ),
      /chronological UTC timestamp/,
    );
    assert.equal(
      readIssueBudget('````markdown\n' + budgetSection() + '````\n'),
      null,
    );
  });

  it('accepts only visible sections and preserves previously admitted estimates', () => {
    const first = budgetSection();
    assert.equal(readIssueBudget('<!--\n' + first + '\n## Other\n-->'), null);
    const admitted = admitBudgetRevisions(first);
    const second = budgetSection({
      schemaVersion: 1,
      revisions: [
        firstEstimate,
        { ...firstEstimate, revision: 2, allocatedTokens: 9000 },
      ],
    });
    assert.equal(admitBudgetRevisions(second, admitted).length, 2);
    assert.throws(() =>
      admitBudgetRevisions(
        first.replace('"profile":', '"incorrect":'),
        admitted,
      ),
    );
    assert.throws(() => admitBudgetRevisions('', admitted), /immutable/);
    assert.throws(
      () =>
        admitBudgetRevisions(
          budgetSection({
            schemaVersion: 1,
            revisions: [
              {
                ...firstEstimate,
                estimatedTokens: firstEstimate.estimatedTokens + 1,
              },
            ],
          }),
          admitted,
        ),
      /immutable/,
    );
  });

  it('permits an epic grouping and only authorized urgent incident exceptions', () => {
    const incidentBody =
      body +
      budgetSection({
        schemaVersion: 1,
        exception: {
          kind: 'urgent-incident',
          reason: 'Restore failing release validation.',
        },
      });
    const changeLabel = (oldLabel, newLabel, labels = newIssue().labels) =>
      labels.map((label) => (label === oldLabel ? newLabel : label));
    const epicLabels = changeLabel('type:feature', 'type:epic');
    const criticalLabels = changeLabel('priority:medium', 'priority:critical');
    assert.equal(validateIssue(newIssue({ labels: epicLabels })).ready, true);
    assert.equal(validateIssue(newIssue({ body: incidentBody })).valid, false);
    assert.equal(
      validateIssue(newIssue({ body: incidentBody, labels: criticalLabels }))
        .ready,
      true,
    );
    assert.equal(
      validateIssue(
        newIssue({
          body: incidentBody,
          labels: changeLabel('owner:codex', 'worker:ivy', criticalLabels),
        }),
      ).valid,
      false,
    );
  });
});

describe('issue metadata policy', () => {
  for (const worker of ['ivy', 'foreman-cloud', 'peon-cloud']) {
    it(`admits ${worker} without admitting local role aliases or critical assignments`, () => {
      const labels = [
        'priority:high',
        'review:critical',
        'target:develop',
        'type:feature',
        `worker:${worker}`,
        'status:ready',
      ];
      assert.equal(
        validateIssue({ ...issue(labels), number: 259 }).ready,
        true,
      );
      assert.equal(
        validateIssue({
          ...issue(
            labels.map((label) =>
              label === 'priority:high' ? 'priority:critical' : label,
            ),
          ),
          number: 259,
        }).valid,
        false,
      );
      for (const alias of ['foreman', 'architect', 'ivy-cloud'])
        assert.equal(
          validateIssue({
            ...issue(
              labels.map((label) =>
                label === `worker:${worker}` ? `worker:${alias}` : label,
              ),
            ),
            number: 259,
          }).valid,
          false,
        );
    });
  }
  it('requires one independent review tier on new actionable issues', () => {
    const labels = [
      'priority:low',
      'target:develop',
      'type:chore',
      'owner:codex',
      'status:ready',
    ];
    const fresh = { ...issue(labels), number: 103 };
    assert.ok(
      validateIssue(fresh).errors.includes(
        'Use exactly one review label for new actionable issues.',
      ),
    );
    assert.equal(
      validateIssue({ ...fresh, labels: [...labels, 'review:light'] }).ready,
      true,
    );
    assert.ok(
      validateIssue({
        ...fresh,
        labels: [...labels, 'review:light', 'review:critical'],
      }).errors.includes(
        'Use exactly one review label for new actionable issues.',
      ),
    );
    assert.ok(
      validateIssue({
        ...fresh,
        labels: [...labels, 'review:unknown'],
      }).errors.includes('Invalid review label.'),
    );
  });

  it('accepts a historical issue without a review tier but rejects duplicate tiers', () => {
    const labels = [
      'priority:medium',
      'target:develop',
      'type:feature',
      'owner:codex',
      'status:ready',
    ];
    assert.equal(validateIssue(issue(labels)).ready, true);
    assert.ok(
      validateIssue(
        issue([...labels, 'review:light', 'review:standard']),
      ).errors.includes('Use at most one review label for historical issues.'),
    );
  });
  it('accepts a complete ready issue', () => {
    const result = validateIssue(
      issue([
        'priority:medium',
        'target:develop',
        'type:feature',
        'owner:codex',
        'status:ready',
      ]),
    );
    assert.deepEqual(result, { valid: true, ready: true, errors: [] });
  });

  it('keeps incomplete issues in triage', () => {
    const result = validateIssue({
      title: 'Needs refinement',
      body: '',
      labels: ['status:triage'],
    });
    assert.deepEqual(result, { valid: true, ready: false, errors: [] });
  });

  it('rejects duplicate metadata labels', () => {
    const result = validateIssue(
      issue([
        'priority:low',
        'priority:high',
        'target:develop',
        'type:feature',
        'owner:maintainer',
        'status:ready',
      ]),
    );
    assert.equal(result.valid, false);
    assert.ok(result.errors.includes('Use exactly one priority label.'));
  });

  it('does not let a worker assign critical priority', () => {
    const result = validateIssue(
      issue([
        'priority:critical',
        'target:develop',
        'type:bug',
        'worker:local-4b',
        'status:ready',
      ]),
    );
    assert.ok(
      result.errors.includes(
        'Critical priority must be owned by Codex or a maintainer.',
      ),
    );
  });

  it('rejects self-dependencies', () => {
    const result = validateIssue({
      ...issue([
        'priority:medium',
        'target:develop',
        'type:feature',
        'owner:codex',
        'status:ready',
      ]),
      body: body.replace('None', '#42'),
    });
    assert.ok(result.errors.includes('An issue cannot depend on itself.'));
  });

  it('rejects repeated dependencies', () => {
    const result = validateIssue({
      ...issue([
        'priority:medium',
        'target:develop',
        'type:feature',
        'owner:codex',
        'status:ready',
      ]),
      body: body.replace('None', '#12, #12'),
    });

    assert.ok(result.errors.includes('List each dependency only once.'));
  });

  it('accepts a completed issue when every criterion is checked', () => {
    const completed = {
      ...issue([
        'priority:medium',
        'target:develop',
        'type:feature',
        'owner:codex',
        'status:done',
      ]),
      body: body.replace('- [ ]', '- [x]'),
    };

    assert.deepEqual(validateIssue(completed), {
      valid: true,
      ready: false,
      errors: [],
    });
  });

  it('rejects a completed issue with unchecked criteria', () => {
    const result = validateIssue(
      issue([
        'priority:medium',
        'target:develop',
        'type:feature',
        'owner:codex',
        'status:done',
      ]),
    );

    assert.ok(
      result.errors.includes(
        'Mark every acceptance criterion complete before closing.',
      ),
    );
  });
});
