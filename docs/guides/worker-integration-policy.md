# Worker integration policy

`tools/policy/worker-integration-gate.mjs` evaluates whether a restricted worker pull request is eligible for a trusted integration process. It returns a stable eligibility decision and denial reason codes. It does not contact GitHub, read secrets, run the pull request, or merge it.

The evaluator expects the coordinator to supply current issue and pull request metadata, native dependencies, commit subjects, check results, changed paths, worker identity mapping, and `CODEOWNERS` content from the authorized `develop` revision. Never supply policy inputs from the pull request checkout. `verify` must report success for the exact head SHA.

An issue can pass the worker eligibility gate only when a trusted coordinator has added the `agent:automerge` label and documented a low risk exact file scope in an `Agent integration scope` section:

```markdown
## Agent integration scope

Risk: low
Allowed files:

- `libs/ui/atoms/src/lib/example.spec.ts`
```

Changed paths must match that exact list and must not match any `CODEOWNERS` path. Paths outside scope and protected paths are denied even when checks pass. The coordinator must provide complete file objects from GitHub's pull request files API, including `status`, `filename`, and `previous_filename` for renames. Both sides of renames are checked against `CODEOWNERS` case-insensitively, and filename-only or malformed rename evidence is denied. Never derive changes from the worker's Git index or pull request checkout: a worker can construct an alternate Git tree even when protected files are mounted read-only. The current `CODEOWNERS` parser accepts literal root paths and directory prefixes; unsupported glob syntax makes the protected path policy invalid and denies integration until the evaluator is updated deliberately.

The evaluator is only a policy component. Issue #34 introduced the trusted GitHub runner and its separated credentials; issue #21 covers worker boundaries. Passing this evaluator alone never authorizes a live merge. Workers must not receive the runner credential or call its integration operation directly.

## Trusted GitHub runner

`.github/workflows/worker-integration.yml` is a manual, maintainer-only workflow pinned to the `develop` branch. It checks out only the trusted `develop` policy with persisted checkout credentials disabled. It never checks out or runs pull request code. The integration token is supplied only to the single runner step as `STELLAR_INTEGRATION_TOKEN`; the worker container has no path to the Actions environment or secret store. The workflow also gives its separate `GITHUB_TOKEN` read-only permissions.

The credential owner stores the fine-grained token as the repository Actions secret `STELLAR_INTEGRATION_TOKEN`. Limit it to this repository and these permissions: `contents:write`, `issues:write`, `pull_requests:write`, `checks:read`, and `metadata:read`. Do not grant administration, Actions, workflow, ruleset bypass, or organization permissions. The secret is never written to the checkout, command line, output, artifacts, or caches. Rotate/revoke it in GitHub, replace the repository secret, and disable the workflow for emergency shutdown. Audit workflow dispatches, runner logs, issue comments, PR events, and merge actor/SHA in GitHub.

The job accepts dispatches only from `DanielssonThomas` against `develop`. Its `verify-credential` operation proves authenticated repository read and issue-comment write, and safely probes the repository Actions-administration read endpoint, which must be denied. It does not probe merge by attempting a merge. The worker's separate fork credential remains restricted to its worker fork; the runner never reads or mounts the worker token. Verify the worker's upstream denial only with documented permissions or dry-run checks, never a real upstream write or merge.

`create-pr` reads the validated issue and trusted `tools/policy/worker-integration-identities.json` mapping, finds exactly one `issue/<number>-` branch on the configured worker fork, opens or reuses the matching PR to `develop`, verifies the PR author is the integration identity, and records the PR on the issue. It advances an in-progress issue to review only after a linked open PR exists. Populate that mapping only as part of authorized worker admission; do not give a worker upstream credentials.

`integrate` captures the issue, native dependency identities and states, repository and PR identities, complete commits and changed files, check runs and their App identities, current target revision, protection rules, and Git-blob-verified CODEOWNERS from that target. Native dependencies must match both the configured repository and their global GitHub issue IDs. Effective branch rules must match the complete detailed ruleset inventories. Missing source identities, unsupported protections, incomplete pagination, unresolved required review threads and ambiguous permission responses deny eligibility.

After the existing worker eligibility gate passes, the runner repeats the complete capture and requires its digest to match before using GitHub's normal squash merge endpoint with the exact head SHA. The programmatic interface can also require a previously retained `expectedEvidenceDigest`. This pin binds evidence; it is not Architect approval. Denials leave the PR open. The runner never requests bypass, changes rulesets, writes branch refs or executes PR code. GitHub remains the final merge gate. This manually authorized runner is separate from the offline Architect qualification described below.

The CLI `--operation inspect --issue <number> --pr <number>` uses the same concrete GitHub readers without writing comments, changing issue state or merging. It still requires the host's configured repository, worker mapping and credential. The Actions workflow's existing operation choices are unchanged. Do not supply credentials on the command line or expose the inspection client to worker sessions.

## Protection evidence limitations

The collector currently requires a complete supported classic-protection response and applicable ruleset details. A `403`, generic `404`, unsupported rule or omitted bypass field is not proof that protection is absent. In particular, GitHub's [classic-protection endpoint](https://docs.github.com/en/rest/branches/branch-protection#get-branch-protection) requires administration-read permission, while the integration credential above deliberately lacks it. [Detailed ruleset responses](https://docs.github.com/en/rest/repos/rules#get-a-repository-ruleset) can omit bypass actors when the reader lacks the required access. Such responses stop this route; this change does not expand the credential.

A separately qualified host read source is required before enabling complete capture in that environment. Qualification must distinguish verified absence from inaccessible evidence, cover known-present classic and ruleset protection, and use the exact intended credential and query. A successful query with a maintainer's different credential is insufficient. GraphQL's limited non-admin view is not a substitute for omitted check-source, freshness, review or bypass policy. Unknown policy changes fail closed until explicitly supported and tested.

## Offline Architect decisions

`createArchitectApprovalHost` in `tools/policy/engineering-org/architect-approval.mjs` composes the evidence collector with the existing host session and storage primitives. Its host-only configuration supplies the repository client, trusted worker mapping, retained source evidence pins, separate source/approval/pool roots, registered recipes and a stable authorization ID. Role requests contain only the issue, PR and idempotency key. They cannot select credentials, readers, recipes or an approval identity.

Before review, the candidate bridge checks the original grant, completed attempt, stopped-child receipts, verification, cleanup and prior review against retained digests. It compares the entire supported PR change set and exact contents with that candidate, and requires the current issue requirements to match the original assignment. It supports bounded text additions and modifications. The original review remains bound to its changed-file snapshot; it is never relabeled as a review of the PR head.

A fresh Foreman session reviews the actual PR head, followed by a distinct Architect session receiving the compact review, changed files, commits, check sources, resource evidence and unresolved findings. Both use the shared host pool and pinned child recipes. The built-in recipes inspect fixed inert fixtures; they do not evaluate arbitrary application changes or execute PR source. The host binds the decision to the repository, issue, PR head, target, policy, evidence and independent session records.

`requestApproval` reserves each purpose-specific session once. `inspect` rereads readiness only while the authorization remains current; the maximum lifetime is five minutes. The host checks expiry before and after asynchronous admission refresh and synchronously immediately before spawning each child. Changed evidence, recipe, scope or authorization invalidates reuse. Provider failures and a caller's claimed role or approval cannot manufacture a decision.

When the host proves that a reserved session never started, it durably records that fact against the reservation before releasing shared capacity. The consumed reservation remains consumed. Pre-spawn rejection evidence is private to the host and bound to the session nonce, phase and packet digest; caller-supplied flags or errors cannot establish it. Uncertain execution or failed cleanup remains quarantined. Recovery follows the host journal rather than replaying an uncertain session.

These records are explicitly `inert`. They are not activated single-use merge receipts: `integrate` returns `merged: false` because a live Architect adapter is unqualified. The existing manual runner does not accept these records as authority. `fallback` always denies and labels its result **Not Architect approved**; there is no callable fallback merge route. Live provider qualification, the complete protection read source, machine resource-pool participation and shared claim dependency checks remain required before a live pilot. Issues [#101](https://github.com/DanielssonThomas/Stellar/issues/101) and [#190](https://github.com/DanielssonThomas/Stellar/issues/190) track those gates.

The identity mapping file is trusted policy, not worker input. Each entry has this form:

```json
[
  {
    "id": "peon",
    "forkFullName": "Stellar-AI-Corp/Stellar"
  }
]
```

The runner verifies the authenticated integration identity as PR author because the trusted runner creates cross-fork PRs. Worker ownership and fork checks remain separately enforced by the eligibility evaluator.

## Proposed protected-change route

[ADR 0002](../decisions/0002-independent-integration-approval.md) proposes independent technical assessment and human owner authorization for solo-maintained protected changes. It requires a separate CEO decision and later implementation. It does not extend this runner's low-risk eligibility scope, enable protected-path integration, install an App or change the current ruleset.
