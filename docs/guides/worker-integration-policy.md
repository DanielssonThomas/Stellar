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

Changed paths must match that exact list and must not match any `CODEOWNERS` path. Paths outside scope and protected paths are denied even when checks pass. The current `CODEOWNERS` parser accepts literal root paths and directory prefixes; unsupported glob syntax makes the protected path policy invalid and denies integration until the evaluator is updated deliberately.

The evaluator is only a policy component. Issue #34 tracks the trusted GitHub runner and its separated credentials. Until that runner and issue #21's worker boundaries are verified, simulated eligibility does not authorize a live merge. Workers must not receive the runner credential or call its integration operation directly.
