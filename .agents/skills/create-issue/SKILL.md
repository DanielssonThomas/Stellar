---
name: create-issue
description: Create a Stellar GitHub issue after checking for duplicates and validating its metadata.
---

# Create a Stellar issue

1. Read the current repository guidance and `docs/architecture/overview.md`. Inspect the current code before making technical claims.
2. Follow `docs/guides/issue-workflow.md`. Search open and recently closed issues for the same outcome with `gh issue list --search "<terms>" --state all`. Reuse or clarify a duplicate instead of creating another issue.
3. Write the outcome, context, observable acceptance criteria, constraints, verification expectations, and dependencies. Separate optional technical suggestions from requirements.
4. Select one priority, target, type, and owner label from the conventions in `.github/ISSUE_TEMPLATE/task.md`. New or incomplete work stays `status:triage`. Use `status:ready` only when the issue is actionable and the policy validator passes. Agents may not assign critical priority; use `owner:codex` or `owner:maintainer` for critical issues.
5. Validate a ready issue with `corepack pnpm run policy:validate-issue -- --title "..." --body-file <path> --labels <label> ...`. Use a temporary body file so multiline text is preserved.
6. Create the issue in `status:triage` with `gh issue create --title "..." --body-file <path> --label "..."`. Include exactly one label in each applicable metadata category. Leave incomplete work in triage.
7. For each blocking issue, link the native dependency with `gh issue edit <id> --add-blocked-by <blocker-id>`. Compare the resulting `blockedBy` relationships with the Dependencies section.
8. After metadata and dependencies pass validation, change status to `status:ready`. Confirm the resulting issue URL and labels. Do not claim the issue is ready if validation failed.

Use the authenticated repository owner only after checking `gh repo view`. Do not assume repository visibility or organization access.
