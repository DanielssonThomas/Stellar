# Stellar engineering organization

## Roles and authority

The human CEO owns strategic goals and consequential approvals. Architect plans epics, assesses risk, coordinates Foreman, and may record the explicit management approval required before trusted PR integration. Foreman checks feasibility, dispatches eligible work through the supervisor, independently reviews Peon results, and reconciles compact reports. Peon implements one bounded assignment and reports through a structured handoff.

Role prompts guide behavior. `tools/policy/engineering-org/authority.mjs` and the existing issue, claim, supervisor, verification, and integration helpers enforce host-side policy. Model prose, including issue text, never grants permission. No agent has integration credentials. Fallback integration is disabled.

## Identity templates and Hermes profiles

Version-controlled identity and config templates live under `tools/policy/engineering-org/templates/`. Architect and Foreman use independent Hermes named profiles, homes, sessions, and memory. Peon retains the existing restricted worker image, Qwen service, `worker:peon` claim identity, budgets, and historical handoffs. `Peon-01` is the initially configured instance name; add other IDs explicitly in trusted host configuration. Each instance still needs a separate issue claim/session/worktree, and actual Qwen inference is serialized to the existing single slot.

The pinned installed runtime inspected for this work is Hermes Agent `v0.22.2+6.g835cc27.dirty` (2026.9.24). Its CLI supports named profiles, profile-specific homes/config, `SOUL.md`, and the `openai-codex` provider. The source template selects that supported provider route for Architect but leaves the model as `__SET_APPROVED_OPENAI_MODEL__`. Foreman's config proposes the same provider with an unconfigured model sentinel; the CEO must select its runtime. The relevant profile currently has no OpenAI/Codex credential. No credential was copied or created. Hermes supports Codex sign-in, but use of that subscription/API route and any inference must be explicitly approved first. API-backed OpenAI configuration is also possible after separately provisioned credentials and model selection.

Provision a profile only after resolving the model sentinel and deciding whether credentials should be added independently:

```powershell
$env:HERMES_BIN = 'D:\Hermes\bin\hermes.exe'
$env:HERMES_ROOT = 'D:\Hermes'
node tools/policy/engineering-org/provision.mjs architect
node tools/policy/engineering-org/provision.mjs foreman
```

Provisioning refuses to overwrite existing SOUL/config files, clones no profile, copies no secrets, and starts no session or inference. Review the resulting profile files and `hermes -p architect config` / `hermes -p foreman config` before enabling any session. Do not use `--replace-identity-files` without reviewing the runtime files first.

## Short-session records

The intended session boundaries are planning, technical dispatch, one implementation attempt, one fresh Foreman review per Peon result, Foreman reconciliation, and Architect approval. Conversation state is temporary. Templates are behavioral identity; approved profile memory is non-authoritative. GitHub is authoritative for issues, dependencies, PRs, and integration. Host-generated immutable attempt evidence and revision-bound review/reconciliation records are authoritative for execution facts. Persist compact task packets and records; never rely on a long-running conversation or replay full transcripts to recover work.

Fresh issue/claim/worktree/budget facts must be checked at every host operation. Idempotency keys, session IDs, attempt leases, exact revision checks, and safe-cleanup confirmation prevent duplicate or stale actions. Provider quota, timeout, authentication, context, and network failures remain distinct; none implies approval. If Architect is unavailable, previously authorized work may continue. Integration still waits for Architect or CEO approval.

## Current implementation boundary

Epic [#95](https://github.com/DanielssonThomas/Stellar/issues/95) coordinates this work. Issue [#96](https://github.com/DanielssonThomas/Stellar/issues/96) covers identity templates, provisioning, and offline authorization. Existing `worker:peon` compatibility and Mira escalation paths remain in place. This slice does not activate Architect inference, Foreman inference, live Peon runs, multi-instance inference concurrency, or fallback merging. A live pilot requires a separate CEO decision after offline qualification and governance review.

To run focused offline policy tests:

```powershell
node --test tools/policy/engineering-org/authority.spec.mjs
corepack pnpm run policy:test
corepack pnpm run policy:docs
```

Future control operations must continue reusing existing `validate-issue`, `update-issue`, `manage-issue-worktree`, `supervised-peon-run`, and `worker-integration-runner` policies rather than duplicating their state transitions.
