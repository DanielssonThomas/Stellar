# Stellar engineering organization

## Roles and authority

The human CEO owns strategic goals and consequential approvals. Architect plans epics, assesses risk, coordinates Foreman, and may record the explicit management approval required before trusted PR integration. Foreman checks feasibility, dispatches eligible work through the supervisor, independently reviews Peon results, and reconciles compact reports. Peon implements one bounded assignment and reports through a structured handoff.

Role prompts guide behavior. `tools/policy/engineering-org/authority.mjs` and the existing issue, claim, supervisor, verification, and integration helpers enforce host-side policy. Model prose, including issue text, never grants permission. No agent has integration credentials. Fallback integration is disabled.

## Identity templates and Hermes profiles

### Optional subscription-backed cloud profiles (30 October 2026)

`architect-cloud`, `foreman-cloud`, and `peon-cloud` are separately selectable Hermes profiles. Their source configurations are in `config/hermes-cloud/`; `node scripts/hermes-cloud-profiles.mjs <architect|foreman|peon>` creates a profile, copies the existing role SOUL and applicable role skills, and validates the loaded model, provider, fallback list, and toolsets. An existing cloud profile requires an explicit `--replace`. This command never copies authentication files. The installed Hermes `openai-codex` credential is borrowed through its native provider. The original `architect`, local `foreman`, and governed `peon` profiles remain intact; the local Qwen routes are separate choices, not automatic fallbacks. Mira and Designer are unaffected.

The three cloud profiles expose only the skills toolset. Terminal, file, browser, code execution, connections, delegation, and memory tools are disabled. They have no fallback providers or auxiliary title inference. These profiles can perform bounded planning or review conversation, but no trusted orchestration or production cloud Peon coding route is connected yet. They do not grant GitHub, worktree, merge, approval, or credential authority. Use the trusted host and existing issue policies for any future assignment. A listed Hermes gateway or configured profile does not prove an agent is active.

On Hermes v0.22.5, the account-scoped native Codex model catalog returned both `gpt-6.1-sol` and `gpt-6-luna` (HTTP 200); the fallback picker list alone is not entitlement evidence because Hermes synthesizes forward-compatible entries. `hermes auth status openai-codex` reported logged in. `hermes usage --provider openai-codex --json` reported a Prolite weekly window at 37% used both before and after the bounded smoke tests, resetting 5 November 2026 at 10:53:42 UTC. The account reported no purchased credits, and neither smoke report recorded a separate charge. These observations do not guarantee future quota or unlimited included usage.

After offline config and role policy tests, one read-only `-z` invocation per distinct model returned the expected final response. Architect cloud / Sol returned `CLOUD_SOL_OK` in 5,506 ms: 3,416 input tokens, 8 output tokens, one primary call, plus an unexpected auxiliary title call (245 input and 44 output tokens). The auxiliary call prompted the explicit title-generation disable in every cloud template. Peon cloud / Luna returned `CLOUD_LUNA_OK` in 3,470 ms: 3,381 input tokens, 9 output tokens, one call and zero auxiliary calls. Both usage reports said `provider: openai-codex`, `cost_status: included`, `estimated_cost_usd: 0`, completed without error. `architect-cloud` and `peon-cloud` recorded separate sessions; `foreman-cloud` had no session because Sol was tested only once. No coding assignment, GitHub mutation, or orchestration ran during these tests.

Version-controlled identity and config templates live under `tools/policy/engineering-org/templates/`. Architect and Foreman use independent Hermes named profiles, homes, sessions, and memory. Their current configs expose only the skills toolset; terminal, file, code execution, browser, delegation, connections, memory, and other direct tools remain disabled until a trusted orchestration interface is installed and reviewed. Peon retains the existing restricted worker image, Qwen service, `worker:peon` claim identity, budgets, and historical handoffs. `Peon-01` is the initially configured instance name; add other IDs explicitly in trusted host configuration. Each instance still needs a separate issue claim/session/worktree, and actual Qwen inference is serialized to the existing single slot.

The pinned installed runtime inspected for this work is Hermes Agent `v0.22.2+6.g835cc27.dirty` (2026.9.24). Its CLI supports named profiles, profile-specific homes/config, and `SOUL.md`. Architect retains its unconfigured `openai-codex` provider sentinel. Foreman's existing profile uses the local `Qwen3-14B-Q4_K_M` alias through a proposed loopback-only meter endpoint at `127.0.0.1:18438`; this selection does not authorize inference. No credential is copied or created, and Foreman's identity, skills, tool restrictions, memory approval, and authority remain in place.

Provisioning creates the profile homes without adding credentials. These commands create identities and perform offline profile inspection only; they do not start sessions or inference:

```powershell
$env:HERMES_BIN = 'D:\Hermes\bin\hermes.exe'
$env:HERMES_ROOT = 'D:\Hermes'
node tools/policy/engineering-org/provision.mjs architect --replace-identity-files
node tools/policy/engineering-org/provision.mjs foreman --replace-identity-files
node tools/policy/engineering-org/provision.mjs peon --replace-identity-files
```

Provisioning clones no profile and copies no secrets. Architect and Foreman get independent homes. Peon receives only the new SOUL file; its config is byte-checked and left intact, and its previous SOUL is backed up. The supervised worker mounts the version-controlled Peon SOUL read-only into its ephemeral Hermes home and the offline system-prompt inspector verifies its exact hash and single inclusion. Existing identity/config files are never replaced unless `--replace-identity-files` is explicit. The management-profile provisioner runs Hermes `config`, offline `prompt-size --json`, and `tools list`, and fails if role skills are absent, Architect's model sentinel or Foreman's exact local route differs, or any direct toolset is enabled. A live session still requires a separately reviewed local endpoint and explicit inference authorization.

## Local Foreman model preparation

The installed `D:\Hermes\models\Qwen3-14B-Q4_K_M.gguf` is 9,001,752,960 bytes (8,585 MiB), SHA-256 `500a8806e85ee9c83f3ae08420295592451379b4f8cf2d0f41c15dffeb6b81f0`. Its GGUF metadata reports 40 transformer blocks and eight 128-dimensional KV heads. With an 8,192-token context and Q8 K/V cache, KV storage is about 680 MiB. At inspection, the RTX 4070 SUPER had 9,152 MiB free; weights plus KV already exceed that, before CUDA graph and compute buffers. Full offload is not a safe starting assumption. Begin a no-inference load test at 28 GPU layers, 8K context, one slot, Q8 K/V, and the existing pinned llama.cpp image. Adjust only after measuring actual VRAM, RAM, startup health, and generation speed.

Use a separate rootless Foreman model container and internal network with the verified WSL copy at `/home/peon/.local/share/stellar-foreman-model/Qwen3-14B-Q4_K_M.gguf` (file mode `0444`, parent mode `0555`), UID/GID 1001, dropped capabilities, no new privileges, 8 GiB RAM, 128 PIDs, and no published model port. Reuse the existing credential-free metering proxy on that network, publishing only its API on Windows loopback `127.0.0.1:18438` for Foreman's custom provider. Its per-session token and request limits must be set by the trusted host before any inference. The sequence is: Foreman plans; stop and confirm its model and meter; start Peon; stop and confirm Peon; then start Foreman for review. Check free VRAM and exclude Mira's loaded model at every transition. Mira's profile and process are not modified by this preparation.

Before Foreman operates, test an 8K model-only load without Mira or Peon loaded; inspect GPU and RAM use, network isolation, loopback-only meter reachability, no direct model port, and confirmed cleanup. Then separately authorize a bounded noncoding metered request to measure prompt and generation speed, followed by one supervised Foreman planning/review trial with its disabled toolsets and host authorization gates intact. No Foreman inference is authorized by this configuration change.

For routine short tasks, start the existing pinned Foreman llama.cpp server with `--reasoning off` alongside its verified 8K, 28 GPU-layer, Q8 K/V settings. The installed Qwen3 chat template implements `enable_thinking=false`; `--reasoning off` selects that behavior. `--reasoning-format none` only changes how thoughts are returned and is not a substitute. Foreman's Hermes `agent.reasoning_effort: none` prevents the custom provider from sending the previous `reasoning_effort: high` request override. Inspect this value with `hermes -p foreman config get agent.reasoning_effort`; the `Reasoning` line in `config show` describes the separate display toggle. The previous default-thinking probe used all 128 output tokens in thinking and produced no final text. A separately authorized follow-up should reuse its neutral release-planning prompt for exactly one noncoding request through the existing meter, with one forwarded-request reservation, a 512-token total meter ceiling, no tools, a 60-second client timeout, and `max_tokens: 256`. Success requires nonempty final content, recorded prompt/output tokens and speeds, bounded memory use, and confirmed model, meter, and client cleanup. Do not run this probe as part of provisioning.

Use the exact prompt: “Consider a team planning a small library release. They need to identify the goal, note dependencies, assign a reviewer, test the change, and decide when to publish. Explain in plain English how to organize these steps so responsibilities are clear and surprises are caught early. Keep the answer concise and do not write code.” Send `temperature: 0`, `stream: false`, and no `tools` field. Stop if container memory reaches 95% of its cap, GPU free memory falls below 512 MiB, health fails, the meter denies the request, the client exceeds 60 seconds, or cleanup cannot be confirmed. Record final-content and reasoning-content lengths separately; hidden or reformatted reasoning does not meet the success criterion.

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
