# Offline engineering planning

`tools/policy/engineering-org/planning.mjs` validates bounded Architect planning packets against a separately supplied trusted snapshot. It produces recommendations and a dependency order without calling a model, GitHub or a worker. It does not create issues, change ownership, acquire claims, dispatch work or authorize integration. The [issue workflow](issue-workflow.md) remains authoritative for those transitions.

The caller must obtain and authenticate the snapshot from trusted host records. The validator cannot prove the provenance of an arbitrary JavaScript object or a field named `source`. The live host adapter and authentication boundary belong to orchestration issue #99; they are not implemented here. Do not load agent-generated snapshot fields as host facts.

## Inputs and binding

Call `planEngineeringWork(packet, snapshot, { now })` with an explicit trusted UTC clock. Snapshot and packet use schema version 1 and exact repository, source revision and policy revision identities. `digest` from `planning-evidence.mjs` creates a deterministic SHA-256 over bounded canonical JSON, rejecting sparse arrays, accessor properties and other non-JSON data. Identity fields must have their declared types; coercible arrays or objects are not identities. The packet must name the snapshot digest. Any changed issue contract, scope, search result, capability evidence, repository or revision needs a fresh packet and evaluation.

The snapshot contains:

| Field                                 | Trusted evidence                                                                                                                                                                                                  |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capturedAt`                          | UTC snapshot time; evaluations expire after 30 minutes and reject future timestamps.                                                                                                                              |
| `issues`                              | Existing epic, candidate, search-result and dependency identities, state and status. Existing candidates include a `contractDigest` and native `dependencies`.                                                    |
| `targetBranches`, `authorizedWorkers` | Current authorized target names and registered worker identities. These are supplied by trusted host policy, never the planner.                                                                                   |
| `scopes`                              | One entry per task key, tied to its exact `contractDigest`, with complete anticipated `files`, `riskFloor`, `complexity`, `ambiguous` and `requiredSkills`.                                                       |
| `scopes[].search`                     | Query, search time, complete-open and complete-recent-closed flags, closed window start, result issue numbers and independently assessed duplicate issue numbers. Cover at least the last 30 days of closed work. |
| `evidence`                            | Host-verified attempt ID, worker, skill, outcome, source revision, artifact reference and completion time. Include relevant failures, not only successful examples.                                               |

The packet identifies an existing open epic and at most 64 tasks. Each task has a unique key, milestone, complete issue contract, `after` keys for planned predecessors, and an assignment role/rationale. Issue labels are strings. New issues must stay triage and cannot receive critical priority from planning. Existing issue content and labels must match its trusted contract digest. Exact duplicate contracts and repeated existing issue identities are rejected.

The validator reuses `validateIssue` for required metadata and actionable sections, and also requires context. It projects new triage contracts through actionable validation rather than relying on triage's permissive validation. Numeric body dependencies must exist in the snapshot and match native links for existing issues. Planned task edges are topologically ordered; missing predecessors and cycles are rejected. After new issues are created, the host must replace planning keys with actual issue numbers and establish matching body/native dependencies through the existing workflow. A planning edge is not a GitHub dependency.

## Recommendations and evidence

Risk uses the existing `effectiveTier` classifier, including both paths of a rename, plus the trusted scope floor. A requested review tier below that result is rejected. Anticipated paths are planning evidence only; actual PR files must still be classified afresh at review time.

- A trusted duplicate outcome recommends `reuse` and Architect resolution rather than a second issue.
- Existing active/review/blocked work requires Architect reconciliation, and epic contracts require strategic planning rather than direct worker assignment.
- Ambiguous or unknown-complexity work escalates to Architect.
- Critical or more-than-small work escalates to Foreman for technical assessment. This does not grant Foreman an implementation identity or access to protected files.
- Small ordinary work may recommend Peon only when its identity is authorized and each required skill has a host-verified latest passing outcome. A latest failure, tied failure, or missing skill escalates to Foreman. Historical failures remain visible even after a later passing outcome.
- A different current owner requires Architect ownership review. Unresolved issue dependencies or planned predecessors keep otherwise eligible work queued.

The task's proposed role must agree with the computed role and include a rationale. Self-reported confidence, model claims and extra proposal fields cannot add capability evidence. A passing fixture shows that the deterministic rules handled that fixture; it does not prove an agent's general competence or that a worker may run. Every result has `executionAuthorized: false`.

## Records and verification

`writePlanningRecord(path, packet, snapshot, options)` evaluates the packet itself and exclusively creates a record at a trusted absolute host path. It writes the result and its digest, flushes the file, and never overwrites an existing record. It returns the record digest, which the host must retain independently of the record file. The host owns the record directory and must protect it from agent writes. File flushing is not a portable guarantee of directory-entry survival after power loss.

`readPlanningRecord(path, { snapshotDigest, packetDigest, recordDigest })` checks bounded size, the host-retained record digest and expected evidence identities. Obtain `recordDigest` from the trusted write result, never from the envelope being read. Changing recommendations and replacing the envelope checksum therefore still fails the expected digest check. A partial write, corruption or mismatched snapshot fails rather than authorizing a retry. Hashes are not signatures or proof of producer identity; the trusted host must protect the retained expectation. Preserve a failed record for host-side diagnosis and do not reuse its path automatically. Re-evaluate against current facts before any later issue mutation or dispatch; a saved recommendation is not a claim, authorization lease or readiness transition.

Run the deterministic fixtures with:

```powershell
node --test tools/policy/engineering-org/planning.spec.mjs
```

The suite is also selected by `policy:test` and `policy:org`. It covers issue metadata, search coverage, revision drift, risk and rename escalation, verified success/failure history, ownership, dependency ordering and record corruption. Follow the [epic-planning skill](../../tools/policy/engineering-org/skills/epic-planning/SKILL.md) when preparing inputs, and retain the normal independent review and integration requirements.
