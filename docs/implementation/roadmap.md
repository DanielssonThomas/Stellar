# Implementation roadmap

GitHub Issues and the [Stellar Development project](https://github.com/users/DanielssonThomas/projects/2) are the canonical backlog. The [foundation Epic](https://github.com/DanielssonThomas/Stellar/issues/1) tracks child work; issue labels and relationships hold task status and dependencies.

## Bootstrap boundary

The local Nx/Angular vertical slice, shared atom, tests, issue/commit policies, documentation governance, and CI workflow are implemented. The first GitHub Actions CI run failed on a stale lockfile; the corrected lockfile and subsequent runs passed. GitHub blocks branch rulesets for this private repository unless the account upgrades to Pro or the repository becomes public. Stellar remains private; protected branch enforcement is blocked in [issue #6](https://github.com/DanielssonThomas/Stellar/issues/6). Hermes orchestration and unattended releases remain out of scope.

## Next issue

Continue with [#7: Add governed generators for applications, atomic components, and services](https://github.com/DanielssonThomas/Stellar/issues/7), the next ready issue. The end-to-end issue-to-PR issue remains blocked by branch protection readiness.
