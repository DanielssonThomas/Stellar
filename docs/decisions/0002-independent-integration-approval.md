# ADR 0002: Independent assessment and solo-maintainer authorization

**Status:** Proposed. Requires an explicit CEO decision before activation. Merging this proposal alone does not enable a protected merge route, automation, credentials or a ruleset change.

## Context

Stellar has a solo human maintainer and distinct Architect, Foreman and Peon roles. The PR author can also be the human repository owner. An independent technical assessment, a management recommendation and the owner's authorization answer different questions; none should be inferred from another.

Ruleset `25456574`, inspected on 2026-11-01, applies to `main`, `develop` and `release/**`. It requires a pull request, strict `verify` from GitHub Actions (integration ID `15368`), and resolved review threads. It requires zero approving reviews and no CODEOWNERS approval, and lists no bypass actors. `.github/CODEOWNERS` still identifies repository-governed resources. GitHub mergeability therefore does not establish that internal review and authorization obligations are met. Re-fetch these settings before any decision; this snapshot is not permanent authority.

GitHub prevents a PR author from approving their own PR. A separate reviewer session under the same GitHub account may provide technical evidence, but cannot be represented as an independent GitHub `APPROVED` review. The current restricted-worker integration gate rejects protected paths, and the paid AI review dispatcher is disabled. Neither is an existing general-purpose protected merge route.

## Decision

The proposed immediate route is independent technical assessment followed by an explicit human owner decision for each protected or critical PR. The human can merge through GitHub after rechecking the evidence, or explicitly instruct a trusted host to merge the same head. Agents never receive merge credentials. Existing bootstrap authority is unchanged while this ADR is proposed; this document neither broadens nor revokes it.

### Distinct decisions

| Evidence                         | Producer and purpose                                                                                                                                                                    | What it cannot establish                                                                                 |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Independent technical assessment | A separate qualified reviewer execution or independent human inspects the exact change, tests and risks. Foreman may review Peon work; Foreman-authored work requires another reviewer. | Human authorization, a GitHub approval state, or authority to merge.                                     |
| Architect recommendation         | A revision-bound management judgment on scope, dependencies, readiness and escalation.                                                                                                  | Independent technical findings or the human owner's protected-change authorization.                      |
| GitHub review state              | GitHub records a review from an eligible account. Future rules may require an independent `APPROVED` review.                                                                            | The author's self-review or an agent's claim that approval exists. Current rules require zero approvals. |
| CEO authorization                | The authenticated human owner explicitly accepts or rejects a concrete protected/critical PR and revision after seeing its evidence.                                                    | Permission for later heads, changed scope, ruleset changes, unrelated PRs or production promotion.       |

A GitHub Codex `COMMENTED` review can contribute technical evidence only when the trusted host verifies its source, separate execution, exact reviewed revision and findings disposition. Do not relabel it `APPROVED`. An independent model review must meet the applicable review tier or a separately authorized assessment route. Missing provider evidence or a disabled API review gate cannot be recorded as a passing API check.

### Routes considered

| Route                                   | Ownership and useful assurance                                                                                                                                      | Limitations and GitHub effect                                                                                                                                                                                |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Independent human maintainer/code owner | CEO selects and admits a second real person with appropriately scoped access. They assess the current diff and can submit an eligible approval when not the author. | Requires an available independent person. An approving-review requirement must be separately configured and tested; CODEOWNERS text alone does not enable it. Human CEO authorization remains distinct.      |
| CEO-controlled GitHub App attestation   | A separately administered App publishes a trusted-source readiness check after validating independent assessment, checks and human authorization receipts.          | Requires reviewed implementation, isolated credentials and a human-only authorization channel. A check is not a fabricated GitHub review. The App is not currently installed or authorized by this proposal. |

Use the immediate human decision route while designing the App route under the integration issue. Do not create a second bot account to impersonate an independent human. No fallback merges are proposed. Light/standard work may later qualify for delegated integration, but only after its separate policy, tests and authorization; this ADR does not activate it.

### Proposed authorization receipt

The trusted host collects an evidence packet before asking for a decision. A receipt binds the following fields; agent output may propose a packet but cannot populate trusted provenance or fabricate the human decision:

- Repository owner/name and stable repository ID, PR number, linked issue and authorized target branch.
- Full candidate head SHA, target SHA, complete changed-file/rename evidence digest, effective risk tier and trusted policy revision.
- Independent reviewer identity and execution provenance, reviewed revision, resolved findings, verification evidence and Architect recommendation or explicit human takeover of management judgment.
- Required check names, expected source identities and their successful checked revisions; review-thread resolution and current protection snapshot.
- Human actor identity, original decision evidence reference, decision timestamp, explicit allow/deny, expiry and a unique single-use receipt ID.

The proposed lifetime is at most 24 hours, ending sooner on any invalidation. A push, target movement, changed scope/risk/policy, revoked decision, failing or superseded check, unresolved finding/thread, changed issue owner/target/dependencies or expiry invalidates the receipt. A fresh packet and human decision are required; a host cannot silently carry approval forward. Record consumed receipts so retries cannot perform a second operation. Unknown merge outcomes require reconciliation against GitHub before another attempt.

The human-only authorization channel must be unavailable to agent sessions, including agent-held credentials for the same GitHub account. An ordinary comment bearing the owner's username is insufficient where an agent can write such a comment. The future design must prove authenticated human presence and tamper-evident provenance through a separately controlled channel. Until that exists, keep the decision in the authenticated human conversation/interaction and require a human-controlled merge; do not claim a model-authored receipt is machine-verifiable authorization.

Immediately before merge, the trusted host re-fetches the exact head/target, issue and native blockers, file risk, check sources/results, review findings/threads, revocations and protections. Use the normal GitHub merge endpoint with an expected head; GitHub branch protection remains the final gate. GitHub may evaluate the PR test merge revision for a required check, so record and verify its association with the current candidate head and target instead of accepting an unrelated green run. No force push, administrator bypass or direct protected-branch write is a substitute.

### Staged enforcement proposal

1. Review and explicitly accept this decision separately from any activation. Record the chosen human/App route and who operates it. No current rule or credential changes in this stage.
2. Implement an unprivileged offline evidence evaluator and negative fixtures through the existing orchestration/integration issues. Reports are pending, ready or blocked for an exact revision; they do not merge or run PR code. Establish the human-only channel and reviewer provenance before treating any receipt as authoritative.
3. Qualify the App/check publisher in an isolated test repository or explicitly authorized nonproduction test setting. Its check-writing credential cannot merge or administer the repository. Keep any integration credential separate and unavailable to workers. Validate fork, replay, self-review, stale-head, missing-review, unavailable-provider and protected-file failures, plus successful human authorization.
4. With a separate CEO-approved ruleset change, require the new stable check from its expected App source while retaining strict `verify`, PRs, resolved threads and no bypass. Do not substitute an App check for human authorization; it attests that the required evidence was verified. Prove ordinary and protected test PR behavior before enabling automated integration.
5. Document recovery before activation. Stop integration first and revoke/disable the publisher if provenance or credentials are suspect. Only a separately authorized human administrator may roll back the new check requirement to the recorded previous ruleset, retaining existing protections. An outage remains blocked until that decision; no agent automatically removes the check or treats its absence as success.

Offline qualification must demonstrate at least: independent reviewer success; author/reviewer identity collision denial; forged owner comment denial; stale head/target and changed risk denial; missing or wrong-source CI denial; open review thread denial; expired/revoked/consumed receipt denial; absent CEO authorization for protected work denial; provider failure denial when its review is required; and uncertain merge reconciliation without duplicate execution. These are implementation requirements, not tests run by this proposal.

## Consequences

The solo maintainer can make a legitimate human owner decision even when they authored a PR, while technical assessment stays independent. This does not manufacture a second GitHub reviewer or allow Foreman to review its own work. More automation depends on verifiable host provenance and the human-only channel, not additional prompts.

Protected and critical integration requires a concrete per-PR human decision under the proposed route. Approval of a roadmap or permission to implement is not a receipt for an unknown future revision. Production deployment and `main` promotion remain separately authorized. Preserve original decision evidence and audit records without storing secrets or raw model transcripts.

This proposal leaves branch rules, worker permissions, credentials and runtime behavior unchanged. [Issue #112](https://github.com/DanielssonThomas/Stellar/issues/112) records the pending human decision; [issue #100](https://github.com/DanielssonThomas/Stellar/issues/100) owns later controlled integration. Do not mark activation complete from a documentation merge.

## Related references

- [Engineering organization](../guides/engineering-organization.md)
- [Worker integration policy](../guides/worker-integration-policy.md)
- [AI review priority](../guides/ai-review-policy.md)
- [GitHub: available rules for rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)
- [GitHub: approving a pull request with required reviews](https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/approving-a-pull-request-with-required-reviews)
- [GitHub: troubleshooting required status checks](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks)
