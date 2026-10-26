# Agent issue worktrees

Use the issue worktree manager before editing an assigned issue. It checks the current issue labels, owner, target branch, body dependencies, native blocked-by links, and dependency completion. It requires an authenticated GitHub CLI session with only the permissions appropriate to the worker identity.

```powershell
node tools/policy/manage-issue-worktree.mjs claim 123 --worker codex --session-id <stable-session-id>
node tools/policy/manage-issue-worktree.mjs inspect 123
```

For corrections to an open issue-linked PR already in `status:review`, use `resume-review` with a new stable session ID after the prior claim is released. It checks the same owner, authorized target, exact PR head, existing issue branch and registered worktree, then atomically claims that worktree and reconciles the issue to `status:in-progress`. The PR stays open. A different active session, changed PR, stale claim, missing worktree, or unresolved dependency stops the operation with work preserved. Repeating it with the same session recovers an interrupted status write.

```powershell
node tools/policy/manage-issue-worktree.mjs resume-review 123 --worker codex --session-id <stable-session-id>
```

The supervisor must provide a stable session ID and reuse it to resume. A different session cannot take an active claim. Claims expire after 12 hours; a fresh claim from the same session renews the lease. A stale claim must be inspected and explicitly handed off:

```powershell
node tools/policy/manage-issue-worktree.mjs handoff 123 --from codex --to worker:local-4b --reason "Small worker exhausted its retry budget"
```

Worker owners must be listed in `tools/policy/authorized-workers.json`. Handoff updates the issue owner and status, preserves the branch and worktree, and records the previous and new owner, reason, and time. The current session may hand off its own active claim; another session must wait for lease expiry. A receiving worker claims the ready issue with its own stable session ID.

The manager reuses a single registered `issue/<number>-...` branch for the issue. New work uses that branch from the exact issue target and a sibling worktree named `<repository>-issue-<number>`. Existing directories, detached worktrees, multiple issue branches, or mismatched branch/target state are left untouched and reported for inspection. The manager never removes worktrees or discards changes. `release` relinquishes the current session claim while preserving its branch and files.

Claims live under the repository's shared Git common directory, outside the checked-out files, so worktrees in the same clone coordinate. Separate clones do not share this registry; do not assign the same owner identity to concurrent workers across separate clones. The GitHub issue owner remains the assignment authority. These local coordination features do not enforce operating-system isolation or protect against a process that ignores the manager; those controls are specified separately in the restricted worker security work.
