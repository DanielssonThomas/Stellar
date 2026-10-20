# Manual monthly release

This procedure is maintainer-controlled. No scheduled promotion or automatic release branch rotation is configured. Vercel is not connected yet; production deployment verification becomes applicable after that integration is configured.

## Readiness

This is the manual release procedure; there is no automated production pipeline. `main` is the default production branch and `develop` is the integration branch. An active GitHub ruleset protects `main`, `develop`, and `release/**`: pull requests and the passing `verify` CI check are required, and deletion and force pushes are blocked. No monthly release branch exists yet.

The ruleset does not require an approving review because the repository currently has only one maintainer. Add an independent maintainer and require their review before enabling autonomous work. Vercel is not connected, so production deployment verification is not available yet.

The release boundary is 00:00 on the first day of each month in `Europe/Mariehamn`. If the operator is late or a check fails, keep the release unpromoted and retry after resolving the cause.

## Promote the frozen release

1. Confirm the active `release/YYYY.MM` branch and freeze new changes into it. New work targets the next release or `develop`.
2. Review open issues labeled `release:blocking` for the release. Resolve each blocker or explicitly move its target before proceeding.
3. Run the required CI checks for the release branch, including affected lint, unit tests, build, and Playwright E2E. Confirm the latest successful run corresponds to the branch head.
4. Open a PR from the release branch into `main`. Merge only after required checks pass and a maintainer approves it. A failed or delayed check never authorizes promotion.
5. After merge, verify the production deployment and a user-facing smoke check once Vercel is connected.
6. Open a PR to synchronize the accepted release changes back into `develop`. Resolve conflicts with maintainer review.
7. Create the next `release/YYYY.MM` branch from the synchronized `develop` head. Confirm it exists before changing issue target labels and directing new release work to it.

## Safe retries

Before retrying, inspect the current branch heads and open PRs. If promotion already merged, continue from synchronization rather than merging it again. Do not force-push or create a second branch with the same release name. If a check fails, leave the release unpromoted, fix the cause on an issue-specific branch, and rerun the required checks.
