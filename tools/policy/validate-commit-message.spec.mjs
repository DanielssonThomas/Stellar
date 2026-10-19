import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateCommitMessage } from './validate-commit-message.mjs';

describe('commit message policy', () => {
  it('accepts a descriptive issue-linked conventional subject', () => {
    assert.equal(
      validateCommitMessage('[#142] feat(auth): handle expired sessions'),
      null,
    );
  });

  it('rejects a subject without an issue ID', () => {
    assert.match(
      validateCommitMessage('feat(auth): handle expired sessions'),
      /issue-id/,
    );
  });

  it('rejects emoji in a commit body', () => {
    assert.match(
      validateCommitMessage(
        '[#142] docs: clarify session behavior\n\nUseful context 🚀',
      ),
      /must not contain emoji/,
    );
  });

  it('rejects meaningless subjects', () => {
    assert.match(
      validateCommitMessage('[#142] chore: update'),
      /descriptive commit subject/,
    );
  });
});
