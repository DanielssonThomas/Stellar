---
name: prepare-pr
description: Verify issue work and prepare an accurate pull request to its authorized target.
---

# Prepare an issue pull request

Use the worker identity in the issue owner label without its prefix.

1. Review the [issue workflow](../../../docs/guides/issue-workflow.md), the issue acceptance criteria, and the actual diff. Confirm documentation impact and update its existing authoritative page when behavior changed.
2. From the claimed issue worktree, run the preflight. It fetches current issue state and target, verifies ownership, valid metadata and dependencies, active claim, issue branch, clean working tree, issue-linked valid commit subjects, and non-empty diff:

   ```sh
   node tools/policy/prepare-pr.mjs 123 --worker <identity>
   ```

   Stop on any error. Do not change the target or take another worker's claim. Inspect changed files and diff intent yourself; the preflight cannot judge whether the change satisfies the issue.

3. Run relevant checks based on affected projects and the issue's verification expectations. Report exact commands and results. Never claim an unrun check passed. The CI `verify` result must be checked on the current PR head before any merge decision.
4. Use descriptive issue-linked Conventional Commit subjects in this exact form:

   ```text
   [#123] feat(scope): implement meaningful behavior
   ```

   Allowed types are enforced by `validate-commit-message.mjs`. Do not use emoji or generic subjects. Existing commits are retained; if they are wrong, correct them only on this issue branch and then rerun validation.

5. Open the PR against the issue's `target:` branch with `Fixes #123`. Its body must describe the actual change, verification results, documentation impact, and remaining limitations. Never claim CI succeeded before the result for the current head exists:

   ```sh
   gh pr create --base <authorized-target> --title "[#123] type(scope): meaningful summary" --body-file <reviewed-pr-body-file>
   ```

6. Re-fetch issue and PR state. Move `in-progress` to `review` using `update-issue` only after the open PR is linked to the issue and targets that authorized branch. Workers do not merge PRs. Codex bootstrap merges still require the separately authorized conditions in `AGENTS.md` and the active GitHub ruleset.

Expected output: PR link, target, changed-file summary, actual checks and results, documentation impact, and limitations. A preflight or verification failure is a blocker to report through `handle-blocker` with evidence; do not mark the issue done.
