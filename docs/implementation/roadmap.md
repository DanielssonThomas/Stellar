# Implementation roadmap

GitHub Issues and the [Stellar Development project](https://github.com/users/DanielssonThomas/projects/2) are the canonical backlog. The [foundation Epic](https://github.com/DanielssonThomas/Stellar/issues/1) tracks child work; issue labels and relationships hold task status and dependencies.

## Bootstrap boundary

The local Nx/Angular vertical slice, shared atom, tests, issue/commit policies, documentation governance, CI workflow, and governed generators are implemented. GitHub ruleset 25456574 is active for `main`, `develop`, and `release/**`; pull request #12 passed the required `verify` check. Only one collaborator is available, so independent review and CODEOWNERS approval are unavailable. No production deployment or Vercel account is configured. Hermes orchestration and unattended releases remain out of scope.

## Next issue

Continue with [#8: Complete the manual release procedure and evaluate Vercel readiness](https://github.com/DanielssonThomas/Stellar/issues/8). [#9: Verify the issue-to-worktree-to-PR workflow](https://github.com/DanielssonThomas/Stellar/issues/9) remains blocked until an independent reviewer is available to exercise protected-file review and assess Hermes readiness.
