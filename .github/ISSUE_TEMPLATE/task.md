---
name: Stellar work item
about: Propose a feature, fix, refactor, chore, blocker, or epic
title: ''
labels: ['status:triage']
---

## Objective

Describe the problem or outcome.

## Context

Why is this needed? Link relevant current code or issues.

## Expected outcome

Describe observable behavior or a durable result.

## Acceptance criteria

- [ ] Describe a verifiable outcome.

## Constraints

List binding requirements. Put optional technical suggestions here and label them as suggestions.

## Dependencies

None, or list blocking issue IDs (for example `#123`). Link native issue dependencies when available.

## Verification expectations

List the relevant lint, unit, build, or E2E checks.

## Metadata labels

Before moving this issue from triage to ready, assign exactly one of each (see `docs/guides/issue-workflow.md` for definitions and validation):

- `priority:low`, `priority:medium`, `priority:high`, or `priority:critical`
- `review:light`, `review:standard`, or `review:critical` (independent of priority)
- `target:develop` or `target:release/YYYY.MM`
- `type:feature`, `type:bug`, `type:chore`, `type:refactor`, `type:blocker`, or `type:epic`
- `owner:codex`, `owner:maintainer`, or `worker:<profile-id>`
- One `status:*` label

Maintainers may also use `release:blocking` to identify an issue that prevents promotion of its target release.
