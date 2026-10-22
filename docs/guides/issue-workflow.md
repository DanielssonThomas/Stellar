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

The `main` target is reserved for a fully specified `type:blocker` issue owned by Codex or a maintainer when promoting a narrowly scoped protected policy fix. While the current default-branch validator does not yet accept that target, the issue remains in triage; the issue claim and PR preflight tools permit only this verified rollout bootstrap and do not move it to ready or in-progress. Worker-owned issues cannot target `main`.

## Status and ownership

- `triage` is the only state for incomplete or invalid issues. New issues enter triage and may omit other metadata while being refined. A triage issue may move to `ready` only after the status helper revalidates it as ready and confirms every listed native dependency is closed with `status:done`.
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

The [implement-issue](../../.agents/skills/implement-issue/SKILL.md), [update-issue](../../.agents/skills/update-issue/SKILL.md), [handle-blocker](../../.agents/skills/handle-blocker/SKILL.md), and [prepare-pr](../../.agents/skills/prepare-pr/SKILL.md) skills define worker actions. Progress is appended as issue comments. Status changes require the current owner and expected state; use the issue worktree manager to claim implementation work, and the update helper for evidence-backed blocker or review transitions. The helper re-fetches issue state, writes a complete label set with one API update, and verifies the result. After integration, `done` may be recovered from `triage` only when the issue is closed, all criteria are checked, its linked PR is merged to the authorized target, and the claim is released.

The issue-policy workflow fetches the current issue by number and serializes policy runs per issue; event payload labels are never used for validation or mutations. Policy and claim transitions re-fetch before their full-label update and verify afterward. A same-owner, same-session claim with a registered worktree can reconcile an interrupted `ready`/`in-progress` transition from `triage` after full metadata validation. Handoffs preserve unrelated labels and use one complete-label update.

GitHub does not provide compare-and-swap for issue label sets. Per-issue Actions concurrency serializes policy jobs, while guarded re-fetches, bounded retries, post-write verification, and claim recovery reconcile races with local claim-manager writes. This prevents stale webhook snapshots from driving a triage write and detects most concurrent changes; it cannot make a REST label replacement atomic with a separate external writer. If a process stops in the narrow interval after a conflicting write, the next policy event or same-session claim recovery re-reads and reconciles current state. Never infer successful status from a webhook or command response alone.
