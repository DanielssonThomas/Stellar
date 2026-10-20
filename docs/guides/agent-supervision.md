# Agent supervision

`tools/policy/supervise-worker.mjs` provides a deterministic, model-independent supervisor. It accepts Peon and Mira adapters; it never accepts or invokes a Codex worker. The supervisor is currently verified with simulated adapters. Live worker execution remains gated by [restricted worker security](../architecture/overview.md#governance) and its issue #21.

## Limits and progress

Defaults per worker are two attempts, ten minutes, 64 tool calls, 32,000 reported model tokens, two repeated unchanged failures, and two attempts without worktree progress. Hard ceilings are three attempts, 15 minutes, 128 tool calls, 64,000 tokens, and three repeated or unproductive attempts. Peon and Mira each receive their own tool and token budget; task runtime is capped at twice the per-worker runtime.

Adapters must execute tools through `budget.runTool` and model requests through `budget.runModel`. The model adapter supplies its prompt token estimate and must honor the returned `maxOutputTokens`. Actual provider usage is charged when present; when usage is unavailable, the full reserved prompt and output budget is charged. The supervisor receives a trusted `inspectWorktree` callback and compares its fingerprints; model-written progress claims do not count as worktree progress. A trusted `verify` callback must return at least one passing result before the task can complete.

Restricted live adapters must also expose a trusted `usage()` poll sourced from the metering sidecar, never from Hermes' self-reported usage file. The sidecar applies the supervisor-supplied cumulative limits before forwarding model output, counts tool calls in the complete model response before releasing it to Hermes, and returns monotonic counters over its loopback-only control endpoint. The supervisor polls while the worker runs, updates its handoff counters, and cancels the worker on exhausted budgets or any usage-query failure. A live adapter without this channel is inadmissible; simulated adapters remain useful for supervisor unit tests only.

## Handoffs and recovery

Pass an absolute `handoffPath` to persist the issue number, owner, authorized target, branch, worktree, attempts, file changes, attempted solutions, verification results, and failure evidence after every attempt. `readHandoff` loads that record for a resume. A resume must keep the same issue, target branch, issue branch, and worktree path. Interruption pauses the task and retains the current worker for recovery.

Worker adapters must implement `cancel(reason)` and return `true` only after the worker process has stopped. If timeout or interruption cannot confirm termination, the supervisor marks the handoff unsafe to resume and will not transfer the worktree. Verification callbacks need the same `cancel` contract when they can outlive their deadline. Only a trusted host that independently confirms termination may resume such a handoff with `confirmPreviousWorkerStopped: true`.

When Peon reaches a deterministic stop condition, the supervisor calls `authorizeHandoff`. The trusted host callback must transfer the issue claim to `worker:mira` with the existing issue worktree manager and return the verified owner, target branch, branch, and path. If authorization is absent or differs, the supervisor leaves a resumable `handoff-pending` record and does not start Mira.

If Mira reaches a stop condition, the returned escalation request asks to mark the issue `blocked` for `agent-capability`, includes the handoff evidence, and sets `invoked: false`. The host may provide `recordEscalationRequest` to use the existing `update-issue` workflow with `formatCapabilityBlockerComment`; the callback must only write the issue update and return `true` after confirmation. Without that callback, the request stays in the handoff with `recorded: false`. Neither path launches Codex or consumes paid usage.

These callbacks are integration boundaries, not security controls. The caller must validate current issue ownership and use separately enforced worker permissions and OS isolation before starting a live adapter.
