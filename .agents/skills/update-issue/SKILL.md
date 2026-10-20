---
name: update-issue
description: Record issue progress and verified state changes without replacing another worker's updates.
---

# Update a Stellar issue

Use the identity value in the issue owner label without its prefix, such as `codex`, `maintainer`, or an authorized worker profile ID.

1. Read the [issue workflow](../../../docs/guides/issue-workflow.md) and fetch the issue again. Confirm it is open, its metadata is valid, its dependencies agree with native GitHub links, and its owner matches your worker identity.
2. Write concise progress or verification evidence with the actual commands and outcomes. Do not claim checks you did not run. The helper posts an append-only issue comment; it does not replace the issue description.
3. Record progress:

   ```sh
   node tools/policy/update-issue.mjs comment 123 --worker <identity> --comment-file <utf8-file>
   ```

4. Change status only when the current label matches the state you observed. Supply `--expected <state>` and `--status <state>`. The helper checks allowed transitions and re-fetches the issue after the change:

   ```sh
   node tools/policy/update-issue.mjs status 123 --worker <identity> --expected in-progress --status review --comment-file <utf8-file>
   ```

5. A blocker report must contain `Blocker`, `Evidence`, `Attempts`, and `Progress` sections. A move to `review` requires an open PR that links the issue and targets its authorized branch. Returning a blocked issue to ready requires a `Resolution` section and resolved dependencies.

If ownership, body, dependencies, or status changed during the update, stop and report the fresh state. Do not retry by removing unfamiliar labels or editing the issue body. The helper re-fetches before writing and replaces the full label set in one GitHub issue update, then verifies the resulting state. A write conflict or invalid final state is a blocker to reconcile through fresh evidence; never claim success from the command exit alone.

`done` is recorded only after GitHub shows the issue closed, its linked PR merged to the authorized target, every acceptance criterion checked, and the local claim released. If issue policy has already moved the issue to `triage` while those completion facts were being recorded, re-fetch and use `--expected triage --status done`; the helper still verifies every completion condition. Wait for the resulting issue-policy run and confirm there is exactly one `status:done` label.
