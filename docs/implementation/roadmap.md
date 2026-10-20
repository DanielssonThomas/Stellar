# Implementation roadmap

GitHub Issues and the [Stellar Development project](https://github.com/users/DanielssonThomas/projects/2) are the canonical backlog. [Epic 2](https://github.com/DanielssonThomas/Stellar/issues/16) tracks the autonomous agent development infrastructure; child issue labels and native relationships hold task status and dependencies.

## Bootstrap boundary

The Nx/Angular workspace, governed generators, issue/commit policies, documentation governance, and CI workflow are implemented. GitHub ruleset 25456574 is active for `main`, `develop`, and `release/**`; it requires pull requests and a passing `verify` check, blocks force pushes and deletion, and currently requires zero approving reviews. The current issue-to-worktree-to-PR demonstration is recorded in [issue #9](https://github.com/DanielssonThomas/Stellar/issues/9).

Codex is the temporary bootstrap maintainer for Epic 2 and may create issues, implement, open PRs, and merge its own PRs when the issue, current-head CI, scope, and branch rules are satisfied. This temporary authority does not apply to Hermes. Hermes is not authorized until restricted credentials, independent execution boundaries, and the controlled trial are verified. Production deployment and promotion of `main` require separate authorization. No Vercel account or production deployment is configured.

Epic 2 is active. [Issue #17](https://github.com/DanielssonThomas/Stellar/issues/17) reconciles this documentation; use Epic #16's child issues and native dependencies for the current execution order. Do not claim Hermes readiness until the controlled trial issue #24 is complete.
