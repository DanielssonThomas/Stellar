# Worker integration policy

`tools/policy/worker-integration-gate.mjs` evaluates whether a restricted worker pull request is eligible for a trusted integration process. It returns a stable eligibility decision and denial reason codes. It does not contact GitHub, read secrets, run the pull request, or merge it.

The evaluator expects the coordinator to supply current issue and pull request metadata, native dependencies, commit subjects, check results, changed paths, worker identity mapping, and `CODEOWNERS` content from the authorized `develop` revision. Never supply policy inputs from the pull request checkout. `verify` must report success for the exact head SHA.

An issue is eligible for unattended integration only when a trusted coordinator has added the `agent:automerge` label and documented a low risk exact file scope in an `Agent integration scope` section:

```markdown
## Agent integration scope

Risk: low
Allowed files:

- `libs/ui/atoms/src/lib/example.spec.ts`
```

Changed paths must match that exact list and must not match any `CODEOWNERS` path. Paths outside scope and protected paths are denied even when checks pass. The coordinator must provide complete file objects from GitHub's pull request files API, including `status`, `filename`, and `previous_filename` for renames. Both sides of renames are checked against `CODEOWNERS` case-insensitively, and filename-only or malformed rename evidence is denied. Never derive changes from the worker's Git index or pull request checkout: a worker can construct an alternate Git tree even when protected files are mounted read-only. The current `CODEOWNERS` parser accepts literal root paths and directory prefixes; unsupported glob syntax makes the protected path policy invalid and denies integration until the evaluator is updated deliberately.

The evaluator is only a policy component. Issue #34 tracks the trusted GitHub runner and its separated credentials. Until that runner and issue #21's worker boundaries are verified, simulated eligibility does not authorize a live merge. Workers must not receive the runner credential or call its integration operation directly.

## Trusted GitHub runner

`.github/workflows/worker-integration.yml` is a manual, maintainer-only workflow pinned to the `develop` branch. It checks out only the trusted `develop` policy with persisted checkout credentials disabled. It never checks out or runs pull request code. The integration token is supplied only to the single runner step as `STELLAR_INTEGRATION_TOKEN`; the worker container has no path to the Actions environment or secret store. The workflow also gives its separate `GITHUB_TOKEN` read-only permissions.

The credential owner stores the fine-grained token as the repository Actions secret `STELLAR_INTEGRATION_TOKEN`. Limit it to this repository and these permissions: `contents:write`, `issues:write`, `pull_requests:write`, `checks:read`, and `metadata:read`. Do not grant administration, Actions, workflow, ruleset bypass, or organization permissions. The secret is never written to the checkout, command line, output, artifacts, or caches. Rotate/revoke it in GitHub, replace the repository secret, and disable the workflow for emergency shutdown. Audit workflow dispatches, runner logs, issue comments, PR events, and merge actor/SHA in GitHub.

The job accepts dispatches only from `DanielssonThomas` against `develop`. Its `verify-credential` operation proves authenticated repository read and issue-comment write, and safely probes the repository Actions-administration read endpoint, which must be denied. It does not probe merge by attempting a merge. The worker's separate fork credential remains restricted to its worker fork; the runner never reads or mounts the worker token. Verify the worker's upstream denial only with documented permissions or dry-run checks, never a real upstream write or merge.

`create-pr` reads the validated issue and trusted `tools/policy/worker-integration-identities.json` mapping, finds exactly one `issue/<number>-` branch on the configured worker fork, opens or reuses the matching PR to `develop`, verifies the PR author is the integration identity, and records the PR on the issue. It advances an in-progress issue to review only after a linked open PR exists. Populate that mapping only as part of authorized worker admission; do not give a worker upstream credentials.

`integrate` re-fetches the issue, native dependencies, PR, complete commit list, changed-file records, required check runs, and CODEOWNERS from the current `develop` SHA. It invokes `worker-integration-gate.mjs`, then re-fetches the PR head, target SHA, and exact-head `verify` result immediately before merge. Denials are recorded on the PR and issue while the PR stays open. Eligible merges use GitHub's normal squash merge endpoint with the exact head SHA; the runner never requests bypass, updates rulesets, writes branch refs, or executes PR code. Branch protection remains the final merge gate.

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
