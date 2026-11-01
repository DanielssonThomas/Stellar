# Code review

Start one fresh Foreman session for each Peon result. Supply only the issue, full baseline and candidate revisions, changed-file and commit evidence, acceptance criteria, exact verification results, and worker handoff. Record a version 2 report accepted by `validateReviewReport` in `tools/policy/engineering-org/review-report.mjs`.

Assess every supplied criterion and verification record exactly once. Findings name a criterion and candidate file/line, explain the observed problem and impact, and suggest a correction. Report missing verification as `not-run` or `blocked`; use only the status in the host's evidence. A failed check or unmet criterion needs an actionable finding. The decision is `corrections-required` for defects, unmet criteria or failed checks, `blocked` for remaining uncertainty, and `passed` only when criteria and checks pass without findings.

A reviewer may not approve its own authored work. Never infer passing checks from worker prose or a failed provider call. The offline validator checks consistency with supplied host context; it does not authenticate the caller, acquire evidence, judge code correctness, or authorize integration. Those responsibilities remain with the trusted host. See the offline qualification section in `docs/guides/engineering-organization.md` for fixtures and limits.
