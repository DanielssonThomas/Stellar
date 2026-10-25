import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateIssue } from './validate-issue.mjs';

const body = `## Objective\nAdd an example capability.\n\n## Expected outcome\nThe behavior is observable.\n\n## Acceptance criteria\n- [ ] A user can verify the result.\n\n## Constraints\nKeep changes within shared libraries.\n\n## Dependencies\nNone\n\n## Verification expectations\nRun the affected unit test.`;

function issue(labels) {
  return { number: 42, body, labels: labels.map((name) => ({ name })) };
}

describe('issue metadata policy', () => {
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
