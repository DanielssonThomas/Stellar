# Issue workflow

GitHub Issues are the canonical development contracts. Create an issue only for a distinct outcome, and search for duplicates first. Describe observable results and constraints; technical suggestions are nonbinding unless stated as requirements.

## Metadata

Actionable issues have exactly one label from each category:

| Category | Allowed values                                                                                          |
| -------- | ------------------------------------------------------------------------------------------------------- |
| Priority | `priority:low`, `priority:medium`, `priority:high`, `priority:critical`                                 |
| Target   | `target:develop` or `target:release/YYYY.MM`                                                            |
| Type     | `type:feature`, `type:bug`, `type:chore`, `type:refactor`, `type:blocker`, `type:epic`                  |
| Status   | `status:triage`, `status:ready`, `status:in-progress`, `status:blocked`, `status:review`, `status:done` |
| Owner    | `owner:codex`, `owner:maintainer`, or an authorized `worker:<profile-id>`                               |

`low` is optional polish or cleanup. `medium` is normal feature or nonurgent fix work. `high` is a major foundation, significant defect, or required release work. `critical` is a severe incident or release-blocking failure. Only Codex or a maintainer may assign critical priority; a worker may request escalation in the issue description. Worker IDs must appear in `tools/policy/authorized-workers.json`.

Targets must name an existing authorized branch. The release target uses a four-digit year and two-digit month. `release:blocking` is a maintainer-controlled supplemental label for issues that must be resolved before promoting that release.

## Status and ownership

- `triage` is the only state for incomplete or invalid issues. New issues enter triage and may omit other metadata while being refined.
- `ready` means the required sections, labels, target branch, owner, and dependencies validate. Only ready issues may be assigned for implementation.
- `in-progress` records work started by the explicit owner. Agents must not claim unrelated issues.
- Use `blocked` only after bounded diagnosis and recording evidence; then link the actual blocking issue and notify the coordinator.
- `review` means a compliant PR is open. `done` means the acceptance criteria are met and the PR is integrated.

GitHub assignees may identify a human maintainer. The owner label is the worker identity, so shared bot accounts do not obscure which profile owns the work.

## Issue body and dependencies

Every actionable issue includes an objective, context, expected outcome, observable unchecked acceptance criteria, constraints, dependencies, and verification expectations. Dependencies say `None` or list issue numbers in the `Dependencies` section. Maintain the matching native GitHub blocked-by relationships; the issue validator compares both forms and verifies referenced issues.

Use GitHub sub-issues for Epic membership. Use native dependencies for blocking order. Avoid creating a separate blocker for each local test failure. A capability blocker may be reported on the existing issue without inventing a dependency.

## Implementation path

Start from a validated issue and its exact target branch. Create an issue-specific branch and worktree, make linked conventional commits, run affected checks, and open a PR back to that target. The [create-issue skill](../../.agents/skills/create-issue/SKILL.md) defines the repeatable creation workflow.

Before editing an assigned issue, use the [agent issue worktree guide](agent-worktrees.md) to validate current metadata and dependencies and to claim or safely resume its branch and worktree. The helper rejects a conflicting active session and preserves existing work when a claim is stale or a handoff occurs.

The [implement-issue](../../.agents/skills/implement-issue/SKILL.md), [update-issue](../../.agents/skills/update-issue/SKILL.md), and [handle-blocker](../../.agents/skills/handle-blocker/SKILL.md) skills define worker actions. Progress is appended as issue comments. Status changes require the current owner and expected state; use the issue worktree manager to claim implementation work, and the update helper for evidence-backed blocker or review transitions.
