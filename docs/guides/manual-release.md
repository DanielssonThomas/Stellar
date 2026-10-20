# Manual monthly release

This procedure is maintainer controlled. There is no scheduled promotion or automatic release branch rotation. CI runs on pull requests and on pushes to `main`, `develop`, and `release/**`. The active GitHub ruleset requires pull requests and a successful `verify` check on those branches, and prevents force pushes and deletion.

## Current readiness

The repository currently has `main` and `develop`; a monthly `release/YYYY.MM` branch is created only when a maintainer authorizes a release. No production deployment, Vercel account, or production smoke check is configured. Only one collaborator is available, so independent review and CODEOWNERS approval are not available. Keep production promotion on hold until a second reviewer and the production deployment path are ready. A passing CI check alone does not make a release production ready.

The release boundary is 00:00 on the first day of each month in `Europe/Mariehamn`. If the operator is late, or any required check is failing or pending, leave the release unpromoted. Resume after the cause is resolved; the calendar date never overrides a failed or missing check.

## Prepare and freeze

1. Confirm the intended `YYYY.MM` release and its release-blocking issues. Resolve each issue labeled `release:blocking`, or have its owner update the target before the freeze.
2. From the accepted `develop` head, create `release/YYYY.MM`. Confirm the branch points to the expected commit and that CI completes successfully. Do not recreate an existing release branch; inspect it and resume from its current head.
3. Freeze scope on the release branch. Route new work to `develop` or the next authorized release branch. Make release fixes on issue-specific branches and merge them through pull requests into the current release branch.
4. Check the Actions run for the exact release branch head. Require a successful `verify` result, including the affected format, lint, unit, build, and E2E checks. If the base cannot be determined, CI performs full verification. A skipped E2E project is acceptable only when CI determines it is unaffected.

## Promote

1. Before opening the promotion PR, confirm the release is approved for production, the independent review gate is available, and the deployment and smoke-check steps are configured. Until these conditions are met, stop here and keep `main` unchanged.
2. Open a pull request from `release/YYYY.MM` to `main`. Include the release summary and linked issues. Wait for the required `verify` check and review; merge only after both pass. Never bypass a failed, pending, or missing check.
3. After merge, verify the production deployment and run the documented user-facing smoke checks. Record the deployment and check result with the release. If deployment is not configured, do not describe the release as deployed.
4. Open a second pull request from `main` to `develop` to synchronize the accepted release. Resolve conflicts on a branch and review the resulting diff before merge.
5. Create `release/YYYY.MM` for the next month from the synchronized `develop` head only after the current release is complete. Confirm the branch exists before directing issues to that target.

## Vercel prerequisites

Before connecting Vercel, a maintainer must identify the account owner, project, production and preview environments, build command, output settings, domain, required environment variables, and access scope. Review the plan and expected usage costs, and get explicit authorization for any paid service. Store credentials in the platform's environment-variable settings; do not commit secrets. Verify a preview deployment and its checks before authorizing production deployment. No Vercel account or deployment is currently configured.

## Safe retries and recovery

Before retrying, inspect the current branch heads, merged pull requests, CI runs, and deployments. Retry a failed CI run after correcting its cause on a pull request; a new successful run must correspond to the current head. If the promotion PR already merged, continue with deployment verification and synchronization instead of merging it again. If deployment fails, keep the release record and `main` merge intact, resolve the deployment issue, and retry deployment; use the hosting platform's rollback procedure if production is unhealthy. Do not force-push, delete the protected release branch, or create a second branch with the same release name. If a step's outcome is unclear, stop and have a maintainer inspect it before repeating the step.
