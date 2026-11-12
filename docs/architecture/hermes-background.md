# Hermes background producer compatibility

This is an **inactive compatibility candidate**, not a supported installed API. Issue
[#339](https://github.com/DanielssonThomas/Stellar/issues/339) owns the producer;
[#299](https://github.com/DanielssonThomas/Stellar/issues/299) owns the consumer.
The observation-only plugin at checkpoint `2756b29` remains unchanged. It sends no wakes.

## Current evidence and chosen boundary

The managed installation inspected is Hermes `0.23.1`, commit
`3b421578588243f920886e6fe79a6faa87ea026e`. The current public plugin injection
API accepts conversational text, returns a scheduling boolean, generates a new
internal identity and supplies no trusted lifecycle card or public exact-event query.

The repository's [process qualification](../../tools/hermes-background/qualify_process.py)
uses the real public plugin dispatcher and terminal/process handlers with real harmless
children in a disposable home. It proves source-context propagation and supported versus
unsupported async delivery. Its context is synthetic. It does not prove live named-Ivy ACP
admission, opt-out, replay, visible delivery or speech. An initial Windows-quoting harness
failure was corrected to match the tool's Bash transport; no retained user task was retried.

The actual process route retains spawning identity and creates a genuine trusted completion
card. It deliberately follows compression continuations, exposes no qualified public per-event
revocation/receipt lookup, and can settle unviewed local completions as notes with empty answers.
It remains useful as a future live positive control. A wrapper exit is never evidence that
review/checks/merge or an issue succeeded. Do not fabricate registry events or adopt old processes.

[Hermes PR #110031](https://github.com/NousResearch/hermes-agent/pull/110031), exact inspected
head `05a5d33c363645451d4ef50ca7db0f2aa6082da3`, is unmerged. Its Desktop route requires a
default-profile native `serve` session and returns Future receipts; it is not qualified for
Stellar named-Ivy ACP or durable payload-conflict reconciliation. Its body names a different
historical head. Neither that prose nor upstream native Desktop evidence certifies this route.

The fallback candidate is a narrow host-owned extension over the existing canonical FIFO.
The plugin must use its eventual public facade. It must not import host-private authority,
construct a `SessionActor`, set an internal flag, or patch the core itself.

## Implemented candidate and unimplemented wiring

[contract-v1.json](../../config/hermes-compat/stellar-background-v1/contract-v1.json) defines
the proposed closed `stellar.background.v1` fields and limits. The Python package alongside
it contains a transaction kernel: consent, ID/digest reservation in the same transaction as
real Hermes admission, exact-event lookup, claim/terminal guards, scoped revocation and
durable consumer effect custody. It has no imports with registration effects, public listener,
daemon, schedule, capability advert or automatic migration. No managed source was changed.

The kernel uses an injected **host-only** transaction-local gate. Tests provide a synthetic gate
and exercise actual `SessionDB`, admission, claim and settlement code. This is not proof that a
managed owner invokes the guards. Every `requiredHostPorts` entry in the JSON contract must be
wired and reviewed before runtime capability advertisement. In particular, native capture,
plugin facade, host drain/recovery, terminal failure settlement, live/replay/receipt projection
and #299's consumer effect operations remain integration gates. Missing wiring means unsupported.

## Authority and threat model

Native explicit opt-in establishes a finite expiry, admission budget and revision. The host
captures profile, original logical session, physical target, route, producer and worker
incarnation. These cannot come from model arguments, mutable environment identity, transcript
search or a user-chosen client label. Authentication belongs to the existing host connection;
the candidate deliberately provides no JSON-to-actor or JSON-to-Origin constructor.

Producer code and external Herdr/GitHub facts are separate trust boundaries. Source observations
remain evidence. An exit code does not prove issue completion, and workflow metadata does not
independently verify artifacts. The host's generic `lifecycle_update` marker is distinct from
`process_complete`. Text containing either string grants no authority, workspace effect or
review/merge/deployment permission. In-process Python plugins are trusted code, not an OS sandbox.

The host gate must check current profile/route/physical target, consent revision and required
producer/version inside the transaction that decides admission or claim. It must perform no
external I/O, commit or nested transaction. An exception denies with a bounded code. The initial
candidate refuses any reset/compression/physical rotation; fresh explicit opt-in is required.
Producer absence must be persisted as a required condition, not default-allow when a callback
is unloaded. These host integration responsibilities cannot be replaced by a plugin predicate.

## Event, receipt and effect states

The host freezes and canonicalizes the closed event before hashing. UTF-8 byte limits apply;
floats, unsafe integers, extra authority fields and ambiguous normalization are rejected.
The key is producer/binding/event ID. An identical digest returns the same admission; changed
content conflicts. Reservation, budget charging and canonical admission commit together.
Backpressure does not consume an ID or budget. An ACK is admission, not inference or delivery.

Authenticated inspect returns the original descriptor and canonical admission, authority,
execution generation and admission sequence. A terminal completed result is eligible only
with a nonempty, bounded canonical `final_response` and a still-valid binding. Missing or
expired evidence is unknown, never resend authority. Pending/unknown identities are not deleted
to create capacity. Expired or missing bindings cannot be recreated by submitting an old ID.
There is no automatic GC. A database retains at most 20 bindings, including revoked/expired
bindings, with at most 100 events per grant and two effect records per event. Reaching capacity
refuses new grants; it never evicts replay fences. A future purge policy needs separate review.

Revocation cancels only queued admissions matching the exact producer principal, target and
binding. A foreground request sharing a request string is unaffected. The claim gate and
terminal settlement guard deny stale work. A terminal guard refusal must be settled by the
host adapter as interrupted/unknown without completed delivery; retaining a started row is
uncertainty, not acceptance. Recovery must preserve that distinction.

Consumers must independently validate the closed descriptor on live events, replay and the
canonical receipt before persistence, rendering and speech. `deliveryAuthorized` alone is not
execution authority. `begin_effect` reserves one render/speech operation. A lost ACK returns
unknown and never reauthorizes the effect. `finish_effect` requires the exact authenticated
owner and durable operation ID. A revoked binding stays `revoking`, with `effectsStopped=false`,
while any effect owner retains custody. Timeouts, disconnects and elapsed leases cannot certify
physical stop. Only acknowledgement after the consumer has stopped/relinquished its operation
closes custody. Already emitted text/audio cannot be recalled; audibility requires human evidence.

## Verification and operation gates

Run the isolated candidate checks with the existing managed interpreter; no dependencies install:

```powershell
& '<managed-python>' -I -B tools/hermes-background/test_candidate.py --runtime D:/Hermes/hermes-agent
& '<managed-python>' -I -B tools/hermes-background/qualify_process.py --runtime D:/Hermes/hermes-agent --output artifacts/issue-339/process-qualification.json
```

They use disposable databases/homes, fake source identities and real local fixture processes.
They do not read production credentials, submit to Ivy or qualify a complete foreground profile.
The separate read-only MCP diagnostic reproduced selected-profile tool failure inside an ACP
editor scope while outer and editor-owned connections worked. Its preserved stash
`d494149db7ed131941345eaa0b50c0793640c76b` must not be blindly restored. Foreground MCP recovery
needs explicit scope, review and functional verification; v1 must not bypass trust selection.

There is **no install command for this inactive kernel**. Managed application is not ready.
A future concrete package must pin the exact stable commit and every touched file's pre/post
hash, refuse mismatch and unrelated modifications, preserve original bytes, and have explicit
coordinator-owned install/verify/disable/remove/rollback operations. Removal must deny queued
v1 work independently of a loaded plugin and reconcile outstanding effect custody. A backup
does not itself prove safe rollback. No automatic reapplication after updates is permitted.

Ivy is the sole coordinated managed writer. Never restart the gateway/Desktop during an active
Ivy turn; arrange external handoff and preserve the conversation. Required critical independent
review, exact-schema consumer agreement, removal/foreground tests and an actual governed
named-Ivy ACP idle/concurrent lifecycle-to-visible-answer/speech-once demonstration precede
acceptance. The uncertain old #299 submission remains untouched. No merge/deploy is authorized.
