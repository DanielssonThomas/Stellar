# Offline Hermes coding-context study

## Scope and provenance

This is an offline, synthetic study for issue #78. No Hermes chat, Qwen completion, worker, or metering-proxy request was run. Tokenization and chat-template application used only the existing local server's `/tokenize` and `/apply-template` endpoints with synthetic inputs. The calls returned numeric measurements only. Historical request bodies are unavailable and were not reconstructed.

| Item                      | Verified identity                                                                                               |
| ------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Source baseline           | `origin/develop` `7a2b9ca8f257347bc7248d06925f2adc8c839304`                                                     |
| Worker image              | `ghcr.io/stellar-ai-corp/hermes-worker@sha256:e847e440fb57416aba8336781114a4f9b29d8c9275131cf5a84e019ee870ef31` |
| Image platform / image ID | `linux/amd64` / `5a051efc5095416782291b8325f301f3e2e1d7e3420030a7d7b6042bf523a8e2`                              |
| Hermes source             | `d923a5eb487a17c0a68801bba9ef0f56c81040a8` (v0.22.2)                                                            |
| Peon posture              | CLI `focus`, coding; context 65,536; zero enabled MCP servers                                                   |

Schema generation was executed from the pinned runtime, loading the mounted production Peon configuration and its effective CLI/one-shot filters. It did not start Hermes chat. The source's static `coding` set has 33 tools before filtering. The effective current direct schema set has 19 tools. Before Tool Search disclosure there are 20 registered/reachable schemas; four are deferred behind Tool Search. One-shot mode removes `skill_manage`. The measured direct aggregate is 7,817 tokens, exactly matching attempt 06's independently recorded schema-content count. This agreement validates the reproduction of that schema component, not the entire historical prompt.

## Effective schema inventory

Token counts are from the existing Qwen-compatible tokenizer endpoint over each compact JSON schema and the aggregate serialized schema list. Bytes are UTF-8 serialized bytes. Each tool count is measured independently; counts are not necessarily additive because tokenizer boundaries can change when schemas are concatenated.

| Model-visible tool                     |      Bytes |    Tokens |
| -------------------------------------- | ---------: | --------: |
| `browser_exec`                         |      3,292 |       739 |
| `clarify`                              |      1,773 |       369 |
| `delegate_task`                        |      4,578 |       966 |
| `execute_code`                         |      3,055 |       750 |
| `manage_connections`                   |      4,450 |     1,026 |
| `memory`                               |      3,202 |       721 |
| `patch`                                |        978 |       201 |
| `read_file`                            |      1,185 |       295 |
| `search_files`                         |      2,248 |       487 |
| `skill_view`                           |        907 |       195 |
| `skills_list`                          |        304 |        60 |
| `terminal`                             |      2,671 |       586 |
| `vision_analyze`                       |        810 |       185 |
| `web_extract`                          |      1,087 |       247 |
| `web_search`                           |        766 |       177 |
| `write_file`                           |      1,087 |       233 |
| `tool_search`                          |      1,449 |       337 |
| `tool_describe`                        |        476 |       101 |
| `tool_call`                            |        679 |       140 |
| **Aggregate (serialized as supplied)** | **35,017** | **7,817** |

The 20-schema pre-disclosure catalog is 40,627 bytes / 9,079 aggregate tokens. Deferred names and token sizes are `browser_vault` 323, `process_manage` 341, `session_search` 895, and `todo_list` 281. These are discoverable through the Tool Search bridge under the current profile, but absent from the initial 19 direct model-visible definitions.

### Narrow profile prototype

The pinned Hermes config supports `agent.disabled_toolsets`. In a synthetic config only, disabling `browser`, `clarify`, `code_execution`, `connections`, `delegation`, `memory`, `session_search`, `todo`, `vision`, and `web` leaves a reachable task profile with `terminal`, `process_manage`, `read_file`, `write_file`, `patch`, `search_files`, `skills_list`, and `skill_view`. The initial visible set is seven direct schemas plus the three Tool Search bridge schemas: 2,531 aggregate tokens (11,585 bytes); the underlying reachable set before Tool Search is 2,400 tokens (10,911 bytes).

Pinned source inspection found that the agent builds `valid_tool_names` from the actual visible schemas, rejects calls outside that set, and rebuilds Tool Search definitions with the same enabled/disabled toolsets. Thus the prototype omission is enforced at model dispatch, not just described in instructions. No production profile was changed.

For #50, file read/search/edit, skills listing/view, terminal commands, and process control appear essential to implementation and verification. Repository governance instructions and trusted verification remain required, independently of model tools. Web/browser/vision, delegation, connections, memory/session history, clarify, and todo are plausible omissions for this narrow task. Removing them reduces capability: no web research, visual analysis, helper delegation, persistent memory, or conversational clarification. The profile does not change filesystem, network, identity, or credential permissions. Production adoption still needs review because available model actions change.

## Synthetic result compaction

The offline prototype coalesces only three-or-more consecutive, nonblank, byte-identical stdout lines. It preserves one copy and adds a count plus an artifact/line-range retrieval reference. Unique lines, source excerpts, stderr, exit codes, test failures, and build failures remain byte-for-byte unchanged. Omitted repeats remain retrievable from the trusted full-output artifact; this prototype does not alter Hermes' production handler.

Exact token counts use synthetic fixtures and the compatible tokenizer:

| Fixture                        | Before | After | Saved |
| ------------------------------ | -----: | ----: | ----: |
| Repetitive directory listing   |    352 |    57 |   295 |
| Search results                 |    864 |    68 |   796 |
| Repetitive long command output |  1,839 |    73 | 1,766 |
| Repeated warnings              |    426 |    37 |   389 |
| Source excerpt                 |  1,194 | 1,194 |     0 |
| Test failure                   |     59 |    59 |     0 |
| Build failure                  |     55 |    55 |     0 |
| All seven fixtures             |  4,789 | 1,543 | 3,246 |

The first five results (listing/search/command/warnings/source) total 4,675 to 1,429 tokens (3,246 saved, 69.4%). This is a synthetic corpus scaled near attempt 06's 4,395 tool-role tokens; it is not a reconstruction of attempt 06. Compaction only helps repeated exact lines. It will not reduce unique diagnostics or source content, and output retrieval must be backed by a trusted artifact store before production use.

## Full-request synthetic measurements

Complete synthetic messages were rendered with the pinned model's chat template and tokenized locally. Fixed/system guidance and tool schemas repeat on each request; request 2 and 3 also retain preceding synthetic conversation and add results. These are exact counts for the constructed synthetic prompts, not historical or production prompt counts.

| Scenario            | Request 1 | Request 2 | Request 3 | Growth R1→R2 / R2→R3 |
| ------------------- | --------: | --------: | --------: | -------------------: |
| Current focus       |     8,821 |    13,673 |    13,865 |        +4,852 / +192 |
| Narrow profile      |     3,140 |     7,992 |     8,184 |        +4,852 / +192 |
| Narrow + compaction |     3,140 |     4,746 |     4,938 |        +1,606 / +192 |
| Checkpointed focus  |     8,821 |    10,058 |    10,257 |        +1,237 / +199 |

The full-prompt comparison shows schema removal saves 5,681 tokens per constructed request, while compacting synthetic repeated results saves 3,246 on later requests. These deltas are specific to these fixtures. A checkpoint is modeled separately: it replaces repeated discovery history with a compact status and exact source excerpt, but it does not remove fixed instructions or schemas.

## Three-request token projections

Attempt 06 measured 13,815 prompt tokens on request 1 and 18,428 on request 2 (+4,613). Historical request 3 is unknown. The projection uses 23,041 for request 3 by repeating the observed +4,613 growth; this is an explicit scenario, not evidence. Synthetic prompt savings are applied with either 100% transfer (optimistic upper case) or a 50% planning haircut (not a statistical confidence interval). Cumulative figures include the specified completion reserve on each request.

| Scenario            | Transfer | Prompt tokens R1 / R2 / R3 | Prompt sum | Total with 1,000 completion each | Total with 1,500 each |
| ------------------- | -------: | -------------------------- | ---------: | -------------------------------: | --------------------: |
| Current focus       |        — | 13,815 / 18,428 / 23,041   |     55,284 |                           58,284 |                59,784 |
| Narrow profile      |     100% | 8,134 / 12,747 / 17,360    |     38,241 |                           41,241 |                42,741 |
| Narrow profile      |      50% | 10,975 / 15,588 / 20,201   |     46,764 |                           49,764 |                51,264 |
| Narrow + compaction |     100% | 8,134 / 9,501 / 14,114     |     31,749 |                           34,749 |                36,249 |
| Narrow + compaction |      50% | 10,975 / 13,965 / 18,578   |     43,518 |                           46,518 |                48,018 |
| Checkpointed focus  |     100% | 13,815 / 14,813 / 19,433   |     48,061 |                           51,061 |                52,561 |
| Checkpointed focus  |      50% | 13,815 / 16,621 / 21,237   |     51,673 |                           54,673 |                56,173 |

The combined optimistic case still exceeds the 32,000 budget by 2,749 tokens at 1,000 completion/request and by 4,249 at 1,500. It misses the initial conservative 28,000 target by 6,749 and 8,249 respectively. Even at 100 completion/request its projected total is 32,049; there is no useful safety margin. At 200 completion/request it is 32,349. The half-transfer planning case is materially worse. Therefore the three-request goal is not supported by this evidence under the unchanged cumulative budget.

## Runtime projection

Historical attempt 03 rates are approximately 73.38 prefill tokens/s and 4.92 generated tokens/s; these are not guarantees. For runtime projection, combined prompt totals are divided by the prefill rate and completion tokens by the generation rate. Operational overhead is estimated at 65–120 seconds: roughly 2× the attempt 06 residual of 32.5 seconds after subtracting first-request prefill and generation, with a higher allowance for uncertainty. Tool execution may exceed this estimate.

| Prompt-savings transfer | Completion/request | Projected total runtime |
| ----------------------- | -----------------: | ----------------------: |
| 100% combined           |                100 |               559–614 s |
| 100% combined           |                200 |               620–675 s |
| 100% combined           |                300 |               681–736 s |
| 50% combined            |                100 |               719–774 s |
| 50% combined            |                200 |               780–835 s |
| 100% combined           |              1,000 |           1,107–1,162 s |
| 100% combined           |              1,500 |           1,412–1,467 s |

Three 1,000-token completions alone take about 610 seconds at the historical generation rate, before prefill or tools. Even the optimistic combined case only approaches 600 seconds when completions average about 100 tokens; its 120-second overhead case misses 600 seconds. It is not a robust operating point.

## Security review and recommendation

- The offline profile prototype changes model-visible dispatch capabilities only in synthetic configuration. It does not grant filesystem, network, credential, or runtime access. Production rollout requires an issue-linked review of each omitted capability and the exact trusted config path.
- Result compaction is safe only when full output remains in a trusted retrievable artifact, the omission marker is explicit, and source/error classes remain untouched. Do not deploy a lossy summary-only handler.
- Repository instructions, skills, protected-file enforcement, trusted verification, token accounting, cancellation, and `safeToResume` behavior must remain unchanged.
- Do not use the initial synthetic savings as a guaranteed production reduction. Exact historical prompts are unavailable; actual runtime may retain different history, schemas, tool arguments/results, and template overhead.
- Checkpointing reduces some retained history in the constructed scenario, but by itself is insufficient. It must preserve exact edits, failed checks, task state, and provenance and is a separate workflow change.

**Issue #78 preliminary recommendation at the time:** no-go for another trial under unchanged 32,000-token / 600-second limits; investigate a task-scoped tool profile, retrievable exact-repeat compaction, and complete synthetic request measurements. Issue #80 completed that follow-up; see its updated measurements and decision below. These projections alone do not establish coding ability or authorize a trial.

## Reproduction artifacts

The adjacent scripts implement the schema inspection, synthetic fixtures, compaction, schema filtering, projection model, and tests. The study's numeric tokenizer output is generated transiently; the report contains no prompts, tool arguments, raw results, credentials, or schemas.

For a rerun, execute `inspect-pinned-hermes.py` inside the pinned image with `/workspace/peon-hermes-config.yaml` mounted from the trusted config, this script read-only mounted at `/workspace/inspect-pinned-hermes.py`, and `--network=none --read-only` plus only a temporary writable `/tmp`. Save its sanitized JSON output outside the repository. Then run:

```sh
node tools/policy/context-study/build-synthetic-corpus.mjs <schema-output.json> <synthetic-corpus.json>
node tools/policy/context-study/tokenize-corpus-via-local-qwen.mjs <synthetic-corpus.json>
node tools/policy/context-study/project-history.mjs <token-metrics.json> <projections.json>
node --test tools/policy/context-study/context-study.spec.mjs
node tools/policy/validate-docs.mjs
```

The tokenizer bridge accepts only `/tokenize` and `/apply-template`, has a 90-second internal deadline, and reports counts/categories only. Do not replace the synthetic corpus with private historical prompt material.

## Issue #80 follow-up: production-equivalent profile and retrieval prototype

This section supersedes the earlier #78 projection tables above for the issue #80 scenarios. The earlier tables were preliminary estimates; the figures below use full synthetic message arrays rendered by the pinned Hermes tokenizer's `/apply-template` and `/tokenize` endpoints. No `/completion`, Hermes chat, live metering request, worker, or Peon attempt was used. Fixed synthetic system content was calibrated to 4,803 tokens, matching attempt 06's measured system-role component. This is an anchor for synthetic requests, not reconstruction of the unavailable historical body.

### Pinned tool loading and enforcement

Inspection used image `ghcr.io/stellar-ai-corp/hermes-worker@sha256:e847e440fb57416aba8336781114a4f9b29d8c9275131cf5a84e019ee870ef31` (linux/amd64, local image ID `5a051efc5095416782291b8325f301f3e2e1d7e3420030a7d7b6042bf523a8e2`) and Hermes v0.22.2 source `d923a5eb487a17c0a68801bba9ef0f56c81040a8`. It ran in a rootless, network-disabled, read-only inspection container with only the production config and inspection script mounted read-only plus temporary `/tmp`. Hermes' supported read-only config loader and runtime schema builder were used with `HERMES_SINGLE_QUERY_SESSION=1`, matching the production `-q` path.

Current direct schemas, measured individually as tokens (serialized aggregate is 7,817 tokens; individual schema counts do not sum exactly due to tokenizer boundaries):

| Tool             | Tokens | Tool                 | Tokens | Tool            | Tokens |
| ---------------- | -----: | -------------------- | -----: | --------------- | -----: |
| `browser_exec`   |    739 | `clarify`            |    369 | `delegate_task` |    966 |
| `execute_code`   |    750 | `manage_connections` |  1,026 | `memory`        |    721 |
| `patch`          |    201 | `read_file`          |    295 | `search_files`  |    487 |
| `skill_view`     |    195 | `skills_list`        |     60 | `terminal`      |    586 |
| `vision_analyze` |    185 | `web_extract`        |    247 | `web_search`    |    177 |
| `write_file`     |    233 | `tool_search`        |    337 | `tool_describe` |    101 |
| `tool_call`      |    140 |                      |        |                 |        |

The pre-disclosure Tool Search catalog has 20 schemas / 9,079 aggregate tokens; deferred `browser_vault` (323), `process_manage` (341), `session_search` (895), and `todo_list` (281) are discoverable. In the narrow config, direct task tools are `read_file` (295), `search_files` (487), `write_file` (233), `patch` (201), `terminal` (586), `skills_list` (60), and `skill_view` (195), plus dispatch bridge `tool_search` (231), `tool_describe` (101), and `tool_call` (140): 2,531 aggregate tokens. `process_manage` remains Tool Search-discoverable. The synthetic retrieval design adds `retrieve_output_artifact` at 117 tokens, bringing that schema set to 2,648.

The narrow config was derived only in temporary storage and reloaded through Hermes' actual config loader. Actual runtime schema construction confirmed the reduced set. Pinned turn validation rejected a synthetic `web_search` call because it was disabled; Hermes' Tool Search bridge returned `process_manage` but not `browser_vault`. No executor was called. Source inspection confirms valid model calls are derived from the schemas supplied for that turn and rejected when absent. This establishes Hermes dispatch enforcement for this profile; it does not establish that a production worker was configured with it. The profile preserves repository file/skill/terminal capabilities, but changes model-visible capabilities and therefore still needs separate production review.

### Retrievable compaction staging design

The prototype stores full stdout in an in-memory trusted-process store before coalescing only three-or-more consecutive, nonblank, byte-identical stdout lines. The visible marker includes an opaque random 128-bit reference, exact line range, and omitted/repeated count; it includes no filesystem path or attempt scope. Unique lines, source excerpts, stderr, exit code, and test/build failures remain unchanged. Retrieval requires the current trusted caller to supply the matching attempt scope and returns the original exact selected lines. Missing, cross-scope, expired, invalid-range, size-limit, or closed-store conditions fail visibly with bounded categories. Limits are 16 artifacts, 1 MiB per artifact, 4 MiB total, 60-second default TTL, five-minute maximum TTL; scope cleanup and close cancel retention timers.

This is a staging design, not a live Hermes tool or durable artifact service. In-memory storage loses artifacts on process exit and shares the trusted process boundary. A production adapter would need an independently enforced attempt capability, authenticated retrieval dispatch, bounded streaming/size accounting, storage ACL isolation, expiry/cleanup on all exit paths, and a failure marker that cannot expose reference metadata. Its unavailable-artifact path must remain visible; the model cannot be told that omitted bytes are recoverable if retrieval fails.

Synthetic tokenizer results (before / after / saved): directory listing 352/57/295, search results 864/68/796, repetitive command output 1,839/73/1,766, repeated warnings 426/37/389, source excerpt 1,194/1,194/0, test failure 59/59/0, build failure 55/55/0. Across fixtures: 4,789/1,543/3,246. These are synthetic outputs, not attempt 06 savings. The unique and failure fixtures demonstrate no reduction where safe repetition is absent.

### Full-request token projections

Prompt counts below include synthetic system messages, effective tool schemas, retained prior messages, assistant responses, tool results, synthetic retrieval request/result where applicable, and the pinned chat template. Scenario content is synthetic and is not a claim about historical message composition.

| Scenario                        | Request prompts          | Growth        | Prompt sum |
| ------------------------------- | ------------------------ | ------------- | ---------: |
| Current focus                   | 13,606 / 18,477 / 18,688 | +4,871 / +211 |     50,771 |
| Narrow profile                  | 7,925 / 12,796 / 13,007  | +4,871 / +211 |     33,728 |
| Narrow + retrieval compaction   | 8,072 / 9,807 / 10,466   | +1,735 / +659 |     28,345 |
| Bounded two-request plan        | 8,091 / 10,507           | +2,416        |     18,598 |
| Three requests, growing history | 8,072 / 9,807 / 10,487   | +1,735 / +680 |     28,366 |

Completion reserves are per request. Cumulative totals (prompt plus reserves) for 100 / 200 / 500 / 1,000 / 1,500 completion tokens per request are:

| Scenario                | Cumulative tokens at reserves 100 / 200 / 500 / 1,000 / 1,500 | Headroom vs 32,000                              | Headroom vs 28,000                              |
| ----------------------- | ------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------- |
| Current focus (3)       | 51,071 / 51,371 / 52,271 / 53,771 / 55,271                    | -19,071 / -19,371 / -20,271 / -21,771 / -23,271 | -23,071 / -23,371 / -24,271 / -25,771 / -27,271 |
| Narrow (3)              | 34,028 / 34,328 / 35,228 / 36,728 / 38,228                    | -2,028 / -2,328 / -3,228 / -4,728 / -6,228      | -6,028 / -6,328 / -7,228 / -8,728 / -10,228     |
| Narrow + compaction (3) | 28,645 / 28,945 / 29,845 / 31,345 / 32,845                    | +3,355 / +3,055 / +2,155 / +655 / -845          | -645 / -945 / -1,845 / -3,345 / -4,845          |
| Bounded plan (2)        | 18,798 / 18,998 / 19,598 / 20,598 / 21,598                    | +13,202 / +13,002 / +12,402 / +11,402 / +10,402 | +9,202 / +9,002 / +8,402 / +7,402 / +6,402      |
| Growing history (3)     | 28,666 / 28,966 / 29,866 / 31,366 / 32,866                    | +3,334 / +3,034 / +2,134 / +634 / -866          | -666 / -966 / -1,866 / -3,366 / -4,866          |

The combined three-request cases miss the 28,000 target even with only 100 completion tokens each, and the 1,000-token reserve leaves just 634–655 tokens below the hard 32,000 cap. That is too little uncertainty margin. The bounded two-request plan fits the token budget in every reserve scenario, but whether two responses of 100–200 tokens can perform useful edits is unproven. Attempt 06 measured R1 13,815 and R2 18,428; this study's current-focus synthetic R1/R2 are 13,606/18,477. They are close numeric anchors, not reconstructions. Attempt 06's second request had five tool-result messages and 4,395 tool-role tokens; this study's synthetic message contents do not establish which historical outputs caused that growth.

### Runtime projection

Using historical 73.38 prefill tokens/s and 4.92 generation tokens/s, nominal compute is combined with a sensitivity range for operational time. Attempt 06's single observed residual after subtracting measured first-request prefill and generation is approximately 32.52 seconds. The lower endpoint charges this residual once; the upper endpoint assumes 20% slower token rates and repeats that residual per request. The residual's components (startup, tools, and other work) are not separately known. Rounded projected ranges below are not guarantees:

| Scenario                        | Completion tokens/request: 100 / 200 / 500 / 1,000 / 1,500 | Runtime ranges (seconds) |
| ------------------------------- | ---------------------------------------------------------- | ------------------------ |
| Narrow + compaction, 3 requests | 100                                                        | 480–657                  |
|                                 | 200                                                        | 541–733                  |
|                                 | 500                                                        | 724–962                  |
|                                 | 1,000                                                      | 1,029–1,343              |
|                                 | 1,500                                                      | 1,333–1,724              |
| Bounded plan, 2 requests        | 100                                                        | 327–433                  |
|                                 | 200                                                        | 367–483                  |
|                                 | 500                                                        | 489–636                  |
|                                 | 1,000                                                      | 692–890                  |
|                                 | 1,500                                                      | 896–1,144                |

Three requests do not leave meaningful 600-second margin, even at 100–200 output tokens under the slower/overhead sensitivity. Two requests can fit at 100–200 reserves in this model, but the 100-token scenario is not demonstrated to produce useful implementation work. No coding performance has been demonstrated by this synthetic analysis.

### Decision

Tool scoping plus safe exact-repeat retrieval substantially reduces synthetic prompt cost, but the combined three-request projection still fails the requested <28,000-token criterion. At a 1,000-token reserve it is near the 32,000 cap, while the conservative runtime projection exceeds 600 seconds. **No-go for attempt 07 under current limits.** A two-request workflow is the only plausible unchanged-budget path in this model, and must be designed around a sharply bounded task and sufficient completion allowance; it remains theoretical, not a readiness finding. Before any production integration, separate authorization and security review are required for model-visible tool changes and a trusted artifact retrieval service. Consider first implementing a non-production two-stage request plan with exact checkpoints; if it cannot preserve enough generation budget for implementation, compare a separately authorized budget/runtime change or another model/architecture. Do not change issue #50/#24, production config, budget, image, or tool permissions based on these projections.

Issue #78 historical verification: focused offline tests passed (6/6), the full policy suite passed (148/148), documentation validation covered 25 Markdown documents, and its then-current formatting/lint checks passed. The first CI run failed at formatting and was rerun after correction. Issue #80 verification results are recorded in its issue comment and final PR; do not interpret the historical checks as validating the follow-up changes.
