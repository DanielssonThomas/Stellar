# Engineering Intelligence

Engineering Intelligence records local development evidence for GitHub issues and presents it through Ivy and Stellar Desktop Stage. [GitHub issues](issue-workflow.md) own estimates, ownership, dependencies, and work status. SQLite owns structured observations and comparisons. Ivy's notebook can hold conclusions and references to the underlying issue or fingerprint.

## Collect locally

Use the repository's pinned Node 22 and install dependencies with `corepack pnpm install --frozen-lockfile`. Claim an issue using the [worktree manager](agent-worktrees.md), then run Codex or a Hermes worker in that worktree. From a trusted Stellar checkout, start the collector:

```powershell
node tools/engineering-intelligence/collector.mjs --watch
```

The process polls every 30 seconds. Use `--once` to import one bounded pass and inspect health counts. Stop the watcher with Ctrl+C. The default source directories are the local Codex home and Stellar Hermes profile directory. Existing `CODEX_HOME` and `STELLAR_HERMES_ROOT` settings select their roots. Keep the collector and Desktop under the same user. On Windows, Desktop reads `%LOCALAPPDATA%\Stellar\engineering-intelligence.sqlite`. The collector uses `$XDG_DATA_HOME/stellar/engineering-intelligence.sqlite` or `~/.local/share/stellar/engineering-intelligence.sqlite` on Unix.

The collector examines a recent 48-hour window with per-pass limits. Starting it before work gives the best coverage. It validates claims against the canonical repository and the registered branch and worktree, with Codex subagent links accepted through persisted spawn edges. A chat title or a path resembling a worktree cannot assign an issue. Ivy's own observed Hermes usage can appear without an issue association.

Worktree claims retain the initial budget and subsequent validated revisions. The collector imports those revisions into SQLite and refuses to replace imported history. To import or refresh a particular issue explicitly, use:

```powershell
node tools/engineering-intelligence/history-cli.mjs sync-budget 342 medium
node tools/engineering-intelligence/history-cli.mjs issue 342
```

The optional final argument sets the issue's comparison complexity to `small`, `medium`, or `large`. Apply a consistent rubric before comparing cohorts. A manual import before any claim records the budget as it exists at import time. The original estimate is revision 1. The latest revision supplies the current estimate and allocation.

## What the numbers mean

| Measure             | Meaning                                                                                                                                                                                                                                                                                                        |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Observed tokens     | Input plus output in the measured source. Cached input and reasoning output are subdivisions. Cache-write input is shown separately where observed.                                                                                                                                                            |
| Coverage            | Complete streams have source-supported terminal accounting. An incomplete session can still have observed tokens. Unknown counters stay unavailable. An observed total that exceeds the allocation establishes an overrun even when coverage is partial.                                                       |
| Estimation variance | The issue report retains observed variance against revision 1. Final variance requires complete accounting for all recorded sessions and still depends on collection coverage.                                                                                                                                 |
| Usage by model      | Shows measured model partitions where supported. A thread-wide Codex total without a verified partition stays in the unknown-model group.                                                                                                                                                                      |
| Allowance           | An independently observed account/window percentage. There is no conversion from tokens to subscription percentage. The optional `allowance` command records a trusted snapshot with `source`, `windowMinutes`, `resetsAt`, `observedAt`, and `usedPercent`.                                                   |
| Money               | Current development sources report token counters. An actual or API-equivalent monetary charge remains unavailable without a separately verified billing source. The [spend ledger](ai-review-policy.md#offline-dispatch-contract) continues to own reservations and provider charges for its governed routes. |

## Sources and trust boundaries

- **Codex.** The installed CLI 0.164.0 and Desktop runtime 0.167.0-alpha.3.2 were verified against their generated app-server schemas and with isolated local mock responses. The supported app-server exposes structured command and usage notifications to its connected client. Stellar does not own the existing Desktop client's connection. For standalone sessions the collector opens fixed local thread databases read-only and interprets bounded rollout records through guarded compatibility readers. The runtime's opaque database token column is ignored. Cumulative snapshots replace older observations for accounting. Codex threads are resumable, so turn completion and session accounting completeness are separate. [OpenAI app-server documentation](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)
- **Codex lifecycle.** The tested model hook carried per-request counters without a stable request ID, including byte-identical payloads for two genuine calls. The tested post-tool hook lacked a structured exit code. The collector runs independently of hooks. It adds zero hook delay, no prompt context, and zero inference requests.
- **Hermes.** The pinned local profile databases are opened read-only. The verified Hermes v0.22.5 state schema exposes profile/model and session usage. Where reported, cache-read and cache-write counters are reconciled with Hermes's uncached input counter. A session's tool records can establish categories without reliable exit status. Tool outcomes remain unavailable when the source lacks them.
- **Sanitization.** Bounded recognized command results are classified in memory. Canonical records contain hashed identities and diagnostic details, fixed descriptions, limited model/technology labels, known lifecycle values, counts, exit statuses and provenance. Prompts, reasoning text, raw command lines, raw output, credentials, transcripts, and filesystem paths are excluded. Explicitly mark a simple shell check with ` # stellar:diagnostic` when a failure is expected. Diagnostic attempts remain in history and are excluded from repeated-failure candidates.
- **Compatibility.** The runtime databases and rollout layouts are internal. Missing, inaccessible, changed, or inconsistent records can produce incomplete coverage. Source and destination failures affect collector health. Ordinary Codex and Hermes execution continues independently of collection. The local history is observational and confers no authorization.

On Windows, twenty paired fixture polls against independent one-session Codex homes took 276 ms median and 462 ms p95 with the watcher cache. Mean collector process CPU was 56 ms per pair, excluding child Git CPU. Sampled RSS increased about 2.67 MiB during the scan and Hermes validation run. The fixture SQLite file occupied 128 KiB. These measurements describe the tested fixture, including the Git claim lookup.

## Investigate engineering problems

`node tools/engineering-intelligence/history-cli.mjs patterns` returns the top repeated signatures. Filter in Ivy by issue, agent or model, period, component, fingerprint, or observed skill version. Counts use structured error codes and a digest of bounded diagnostic details. Retry and resolution require an observable matching operation within the same session. A later success establishes that an invocation passed, with the reason for the change unknown. Test diagnostics, unmatched operations, and human corrections have different evidence. The current collector makes no inference about equivalent human instructions.

Candidates are investigation starting points. Choose the underlying remedy based on evidence. Supported intervention types include existing or new skills, validation hooks, CI/static analysis, generators, architecture, documentation, issue specifications, and a decision to take no action.

Record an intervention with `history-cli.mjs intervention <json-file>`. Supply `id`, `kind`, `version`, UTC `startedAt`, `fingerprints`, `implementationRef`, `expectedImprovement`, and `windowDays` (1 to 90). Optional `model`, `reasoning`, and `complexity` restrict the cohort. Evaluate it with `history-cli.mjs evaluate <id>`. The comparison uses matching technology, component and check category, counts eligible attempts on both sides, and reports failure frequency, retries, sessions, and observed session tokens. It labels missing and small cohorts. Token coverage and cohort differences can limit interpretation. Snapshots preserve the measured outcomes available at evaluation time. Treat an association as a hypothesis until stronger evidence supports it.

## Inspect skill overhead

Install the isolated tokenizer once before inventorying skills. The passive collector uses Node's built-in modules.

```powershell
npm ci --prefix tools/engineering-intelligence --ignore-scripts --no-audit --no-fund
```

`node tools/engineering-intelligence/history-cli.mjs inventory` records checked-in skill versions using their content hashes. It estimates the standalone `SKILL.md` size with `o200k_base` in pinned `js-tiktoken`. Static size excludes discovery metadata, chat framing, references, and provider-specific loading. Model-specific loaded context remains unavailable without trusted observations.

Use `skill-state <json-file>` with `skill`, `version`, `recordedAt`, `state` and optional `transferEvidence`. State can be candidate, experimental, validated, maintained, retired, or merged. Use `skill-activation <json-file>` only with verified evidence. Supply a stable `id`, `sessionId` returned by Ivy, `skill`, `version`, `at`, and `provenance`. If you have the original collector identity instead, include its `source`. Include measured `loadedTokens`, `referenceTokens`, and `discoveryTokens` where supported. Observed activations and associated failures describe the captured cohort. Transfer and net savings require comparable tasks and preferably controlled comparisons.

## Read through Ivy and Stage

Ask Ivy to show Engineering Intelligence or a particular issue, session, recurring failure, or skill. The existing Desktop workspace MCP exposes `get_engineering_intelligence` and `show_engineering_intelligence` inside an active Ivy turn. It reads fixed SQLite views with bounded parameters and results. Stage uses the existing presentation, text and Chart.js renderers for Development Budget, Session Intelligence, Engineering Patterns, and Skill Intelligence. The Desktop frontend does not receive a filesystem or SQL capability.

## Storage and maintenance

Schema version 1 uses a dedicated SQLite application ID, transactional migrations, WAL and foreign keys. Stable event keys and cumulative counter partitions protect concurrent and replayed writes. Issue budget revisions and summarized outcomes stay available after session detail expires. Run `node tools/engineering-intelligence/history-cli.mjs maintain` periodically to prune detail older than 180 days, with up to 500 sessions per call. It keeps compact per-issue usage rollups and runs SQLite optimization and a passive WAL checkpoint. The main database is capped at 32,768 pages. The collector reports storage failures without blocking work. Preserve a copy before replacing or repairing a damaged history database. Application and schema identity checks reject incompatible stores.
