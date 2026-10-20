---
name: implement-issue
description: Implement one validated Stellar issue in its assigned worktree and preserve evidence for review or handoff.
---

# Implement a Stellar issue

Input: one GitHub issue number and the assigned worker identity.

Pass the identity value in the issue owner label without its prefix, such as `codex` or an authorized worker profile ID.

1. Fetch the issue and inspect its labels, target, acceptance criteria, body dependencies, and native blocked-by links. Read the [architecture overview](../../../docs/architecture/overview.md) and [issue workflow](../../../docs/guides/issue-workflow.md). Do not start when metadata is invalid, ownership differs, the target branch is missing, or a dependency is unresolved.
2. Obtain a stable session ID from the supervisor. Claim or resume the worktree using the deterministic manager:

   ```sh
   node tools/policy/manage-issue-worktree.mjs claim 123 --worker <identity> --session-id <stable-session-id>
   ```

   A claim error is a stop condition. Do not make another branch or edit a shared checkout as a workaround. Use `inspect` to review a prior claim and `handle-blocker` for a stale or conflicting assignment.

3. Inspect the assigned worktree, its current diff, and relevant projects/tags. Preserve existing changes. Write a short bounded plan tied to the issue's acceptance criteria before editing.
4. Implement the smallest complete change within the issue scope. Add meaningful tests for executable behavior and update the authoritative documentation when behavior changes. Do not modify another issue's worktree.
5. Run the relevant checks. Record the exact commands and results with `update-issue`; never report unrun checks as passing.
6. If acceptance criteria pass, hand the actual diff to `prepare-pr`. If progress is blocked, stop after bounded diagnosis and use `handle-blocker` with evidence and the preserved worktree.

Expected output: issue number, owner, target, worktree and branch, bounded plan, changed files, actual verification results, and either a PR handoff or a structured blocker. Never silently change the target or mark the issue done.
