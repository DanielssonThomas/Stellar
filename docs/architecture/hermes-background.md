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

## Implemented candidate and remaining integration gates

[contract-v1.json](../../config/hermes-compat/stellar-background-v1/contract-v1.json) defines
the proposed closed `stellar.background.v1` fields and limits. The Python package alongside
it contains a transaction kernel: consent, ID/digest reservation in the same transaction as
real Hermes admission, exact-event lookup, claim/terminal guards, scoped revocation and
durable consumer effect custody. It has no imports with registration effects, public listener,
daemon, schedule, capability advert or automatic migration. No managed source was changed.

The [host callable interface](../../config/hermes-compat/stellar-background-v1/host-interface-v1.json)
adds a concrete host adapter and eight-file pinned source patch specification. The candidate
places checks inside actual FIFO claim, terminal settlement and captured-result recovery
transactions. A refused queued head follows the existing exact-head cancellation path so ordinary
foreground input can advance. Denied v1 settlement suppresses captured text, transformed responses
and content-bearing terminal callbacks. Foreground callbacks remain unchanged.

The host captures the original destination and finite consent behind mandatory native-transport,
explicit-gesture and transaction-local policy verifiers. A one-use consent ticket expires within
60 seconds and belongs to the actual connection. Legacy owner registration also admits Webapp
owners and is insufficient native proof. No RPC/tool method mints tickets or accepts an Origin.
The plugin receives `ctx.background_v1` only through the verified host loader's exact profile/plugin
manager. Its facade freezes/hashes events before an attempt, submits through tracked ordered writes
and inspects after uncertain ACKs. Unregister removes only its own facade. Producer incarnation to
artifact-version binding is immutable and bounded to 20 retained identities; upgrades require a new
incarnation and fresh consent.

The source candidate projects the same `background_v1` descriptor onto `message.start` and
`prompt.receipt`; actual `SessionEvents` replay/catch-up retains the frame's existing authority,
generation, admission, sequence and replay epoch. Native effect RPCs derive custody from the
authenticated subject **and transport**. Another connection for the same person cannot acknowledge
that an old connection stopped speech. A lost transport therefore stays revoking until its actual
owner can acknowledge; authenticated custody recovery would need a separate reviewed contract.

Tests use actual `SessionDB`, patched canonical functions, result handling, event replay and exact
host method bodies extracted without starting the gateway. Native/policy/gesture callbacks and
connections are synthetic. Host construction verifies all 15 pinned files/postimages and the
executing canonical functions; it refuses partial changes, unknown updates or stale loaded code.
This is not complete loaded-module or managed bootstrap qualification. Native verifier/gesture
integration, reviewed host composition, consumer persistence/render/speech enforcement, capability
advertisement and real named-Ivy ACP acceptance remain gates. Missing wiring means unsupported.

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
& '<managed-python>' -I -B tools/hermes-background/test_host_ports.py --runtime D:/Hermes/hermes-agent --evidence artifacts/issue-339/host-ports/qualification.json
& '<managed-python>' -I -B tools/hermes-background/qualify_process.py --runtime D:/Hermes/hermes-agent --output artifacts/issue-339/process-qualification.json
```

They use disposable databases/homes, fake source identities and real local fixture processes.
Host-port tests prohibit bootstrap, subprocesses and external networking (Windows asyncio's
loopback self-pipe is allowed). The unrelated restart-notice helper is explicitly mocked because
its import starts full gateway bootstrap. An initial test exposed that behavior and was stopped;
it is not a passing isolated test. Managed source and selected installation facts stayed unchanged.
They do not read production credentials, submit to Ivy or qualify a complete foreground profile.
The separate read-only MCP diagnostic reproduced selected-profile tool failure inside an ACP
editor scope while outer and editor-owned connections worked. Its preserved stash
`d494149db7ed131941345eaa0b50c0793640c76b` must not be blindly restored. Foreground MCP recovery
needs explicit scope, review and functional verification; v1 must not bypass trust selection.

There is **no install command for this inactive candidate**. `export_patch.py` only exports a diff
and pre/postimage manifest into this issue's artifacts. `overlay.fixture` only builds empty
temporary source fixtures and `undo_fixture` requires the complete independently derived manifest
before restoring any bytes. Tests verify byte-identical source restoration. This is not a durable
installer, production removal or rollback qualification.

Before any coordinator-owned application: verify the exact commit, 15-file base pin, eight-file
postimages and candidate artifact hashes; review the diff and genuine native/consumer composition;
quiesce outside an active Ivy turn; preserve exact original bytes and canonical state; then verify
loaded code and functional foreground/profile boundaries. No hot patching or automatic reapplication
after an update is supported. Explicit `Host.detach()` durably disables producer registrations,
revokes grants and cancels exact queued v1 admissions while retaining all identity/effect records.
Keep authenticated finish/inspect available until outstanding custody is reconciled. Only after
that gate may a separately reviewed removal restore exact source bytes and remove the package.
Unknown edits, mismatched hashes or lost custody stop removal; no timeout certifies stopped effects.
Do not delete schema/tombstones to free capacity or roll back a canonical database to resend events.

Ivy is the sole coordinated managed writer. Never restart the gateway/Desktop during an active
Ivy turn; arrange external handoff and preserve the conversation. Required critical independent
review, exact-schema consumer agreement, removal/foreground tests and an actual governed
named-Ivy ACP idle/concurrent lifecycle-to-visible-answer/speech-once demonstration precede
acceptance. The uncertain old #299 submission remains untouched. No merge/deploy is authorized.
