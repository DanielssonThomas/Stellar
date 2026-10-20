---
name: handle-blocker
description: Record evidence-backed blockers and request reassignment without discarding issue work.
---

# Handle a blocked Stellar issue

Use the identity value in the issue owner label without its prefix, such as `codex` or an authorized worker profile ID.

1. Re-fetch the issue and verify your owner, target, status, and dependencies. Preserve the branch and worktree. Stop if another worker now owns the issue.
2. Classify the problem as an unresolved dependency, infrastructure/tool failure, or insufficient agent capability. Keep the diagnosis bounded: retain the relevant error, list attempted fixes, and stop repeating an unchanged failure.
3. Determine whether useful work can continue. If so, record the blocker and continue within the issue scope. If not, create a concise report with these headings:

   ```markdown
   ## Blocker

   ## Evidence

   ## Attempts

   ## Progress
   ```

4. Record the report and move the issue from `in-progress` to `blocked` with the append-only update helper:

   ```sh
   node tools/policy/update-issue.mjs status 123 --worker <identity> --expected in-progress --status blocked --comment-file <utf8-file>
   ```

5. Link an existing issue only when it is the actual dependency. Keep the issue `Dependencies` section and native blocked-by relationship in sync using the [issue workflow](../../../docs/guides/issue-workflow.md). Do not create a separate issue for a routine test failure. Request reassignment using the worktree handoff procedure when appropriate; preserve the branch, worktree, errors, and attempted solutions.

Report whether the blocker is infrastructure or capability and whether the worker can continue. If a small worker reaches its capability limit, request a Mira handoff with this report. If Mira cannot complete the issue, record a Codex escalation request. Do not claim escalation occurred: it must never launch Codex or consume paid usage automatically.
