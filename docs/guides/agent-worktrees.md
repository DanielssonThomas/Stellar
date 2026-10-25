# Agent issue worktrees

Use the issue worktree manager before editing an assigned issue. It checks the current issue labels, owner, target branch, body dependencies, native blocked-by links, and dependency completion. It requires an authenticated GitHub CLI session with only the permissions appropriate to the worker identity.

```powershell
node tools/policy/manage-issue-worktree.mjs claim 123 --worker codex --session-id <stable-session-id>
node tools/policy/manage-issue-worktree.mjs inspect 123
```

The supervisor must provide a stable session ID and reuse it to resume. A different session cannot take an active claim. Claims expire after 12 hours; a fresh claim from the same session renews the lease. A stale claim must be inspected and explicitly handed off:

```powershell
node tools/policy/manage-issue-worktree.mjs handoff 123 --from codex --to worker:local-4b --reason "Small worker exhausted its retry budget"
```

Worker owners must be listed in `tools/policy/authorized-workers.json`. Handoff updates the issue owner and status, preserves the branch and worktree, and records the previous and new owner, reason, and time. The current session may hand off its own active claim; another session must wait for lease expiry. A receiving worker claims the ready issue with its own stable session ID.

The manager reuses a single registered `issue/<number>-...` branch for the issue. New work uses that branch from the exact issue target and a sibling worktree named `<repository>-issue-<number>`. Existing directories, detached worktrees, multiple issue branches, or mismatched branch/target state are left untouched and reported for inspection. `release` relinquishes the current session claim while preserving its branch and files.

The trusted post-job lifecycle calls `tools/policy/cleanup-issue.mjs` after the worker and verification processes and all attempt-owned containers have stopped. It needs a fresh host-generated stop receipt, a durable handoff bound to the issue, branch, path, and exact head, and an external append-only audit path. It releases the current session claim only through `releaseClaim` after the PR is open on the authorized target, the issue is in review, the exact head is pushed, and the worktree has no tracked, untracked, or ignored content. It then uses `git worktree remove` without force. A blocked, dirty, unpushed, ambiguous, or recovery-required job stays intact. The supervisor must create the receipt from actual process and container inspection; an agent report is not stop evidence. The CLI refuses a receipt older than five minutes.

On a merged PR to `develop`, the `post-merge-cleanup` GitHub workflow re-fetches the merged PR and issue from GitHub, checks the event head, target and checked acceptance criteria, and completes the linked issue through `update-issue`. It checks out trusted `develop` policy only and never runs PR code with the issue-writing token. GitHub automatically deletes merged upstream head branches when its repository setting is enabled; the worker fork needs its own setting or separate permission. The local host must still run the merged phase of `cleanup-issue.mjs` in each clone. That phase re-fetches exact merge and open-PR state, checks the claim and registered worktree, removes eligible clean worktrees, and deletes only the verified local issue branch. A remote head still present is preserved unless the trusted host also attests that other clones are safe and remote deletion is authorized; then the helper uses a per-ref lease. It prunes tracking refs and appends each decision to the audit. Repeated runs tolerate already removed worktrees and branches. A separate WSL clone needs its own trusted host invocation and claim registry; never infer its safety from the Windows clone.

Claims live under the repository's shared Git common directory, outside the checked-out files, so worktrees in the same clone coordinate. Separate clones do not share this registry; do not assign the same owner identity to concurrent workers across separate clones. The GitHub issue owner remains the assignment authority. These local coordination features do not enforce operating-system isolation or protect against a process that ignores the manager; those controls are specified separately in the restricted worker security work.
