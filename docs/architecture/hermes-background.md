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
head `05a5d33c363645451d4ef50ca7db0f2aa6082da3`, was unmerged when inspected. Its Desktop route requires a
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
adds a concrete host adapter and nine-file pinned source patch specification. The candidate
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

The source candidate projects the same `background_v1` descriptor onto `message.start`,
`message.complete`, queued cancellation and `prompt.receipt`; actual `SessionEvents` replay/catch-up retains the frame's existing authority,
generation, admission, sequence and replay epoch. Native effect RPCs derive custody from the
authenticated subject **and transport**. Another connection for the same person cannot acknowledge
that an old connection stopped speech. A lost transport therefore stays revoking until its actual
owner can acknowledge; authenticated custody recovery would need a separate reviewed contract.

Tests use actual `SessionDB`, patched canonical functions, result handling, event replay and exact
host method bodies extracted without starting the gateway. Native/policy/gesture callbacks and
connections are synthetic. Host construction verifies all 15 pinned files/postimages and the
executing canonical functions and already-loaded critical host call sites; it refuses partial
changes, unknown updates or stale/foreign loaded code. A packaged fixture also verifies the exact
loaded package directory, immutable bundle and canonical package/phase identity.
For the managed layout, the selected dependency workspace has no install stamp. Composition must
explicitly supply its bootstrap root and managed facts path together. The verifier checks the
bootstrap stamp, the facts-selected environment/lock paths, exact workspace bytes and loaded code
at that selected workspace. It never invents a stamp or silently selects another installation.
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

Revocation reserves bounded observer obligations in the same canonical transaction as queued
cancellation. The live owner uses tracked `Host.detach_and_settle()` or the public revoke RPC to
pay ordinary canonical waiter, producer-bracket and event-stream settlement. A concurrent submit
which wins before revocation is included; commit-then-error retains the obligation for exact
retry. A publication interruption may repeat a completion frame, never admission or inference.
Stable event/receipt identity and effect custody remain the side-effect fences. Quiescent package
disable retains these records without claiming that a viewer received a frame.

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
& '<managed-python>' -I -B tools/hermes-background/test_package.py --runtime D:/Hermes/hermes-agent --evidence artifacts/issue-339/package/qualification.json
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

## Current consumer reconciliation

The [A–F amendment record](../../config/hermes-compat/stellar-background-v1/integration-amendments-7ef1c34.json)
reconciles producer `474c1b8` with the superseding continuation of consumer `7ef1c34`.
Historical proposed `session.background.*` names are not implemented. Keep the closed
`stellar.background.bind/inspect/effect.begin/effect.finish/revoke` interface. No bindings-list or
lost-bind-ACK recovery RPC exists. A stream descriptor cannot reconstruct consent or authorize rebind.
The original contract and interface artifact bytes retain fingerprints `008c72c9…ec724` and
`392c027a…6821e`. Future negotiation requires both full hashes; this candidate's describe hook
withholds the capability and both fields. Fixture/caller flags cannot activate them.

Native gesture/transport attestation to the host-only approve port remains a separate genuine
adapter gate. The proposed consumer monitor coalesces at most 16 active events/session, inspects
each original event at a 1-second target interval and immediately before dispatch, and uses the
earlier event/consent expiry as a deadline. Denial, unknown, outage or stale inspection requests
owned cleanup/stop and withholds future effects. Only actual native/render/playback acknowledgement
permits finish. A suspended client cannot promise a physical 1-second stop; unknown custody stays
unknown. Consumer accept/amend and real timing tests are required before activation. No monitor,
schedule, native IPC or renderer effect is installed by this host package.

## Disposable package lifecycle

The [fixture lifecycle tool](../../tools/hermes-background/package_fixture.py) is executable only
against explicitly enrolled, empty temporary directories. It copies the 15 pinned source files,
original stamp and nine exact preimages, and retains a byte-pinned operator bundle. Other Python
dependencies remain read-only imports from the pinned source in isolated probes. This is a
runtime **source fixture**, not an alternate production installation or complete Hermes bootstrap.
`export_patch.py` remains a diff/manifest exporter with no apply operation.

For example, with an existing managed interpreter and a new empty directory under TEMP:

```powershell
& '<managed-python>' -I -B tools/hermes-background/package_fixture.py prepare --root '<empty-TEMP-fixture>' --source D:/Hermes/hermes-agent
& '<managed-python>' -I -B '<fixture>/bundle/fixture-entry.py' install --root '<fixture>' --source D:/Hermes/hermes-agent
& '<managed-python>' -I -B '<fixture>/bundle/fixture-entry.py' verify --root '<fixture>' --source D:/Hermes/hermes-agent
& '<managed-python>' -I -B '<fixture>/bundle/fixture-entry.py' disable --root '<fixture>' --source D:/Hermes/hermes-agent
& '<managed-python>' -I -B '<fixture>/bundle/fixture-entry.py' remove --root '<fixture>' --source D:/Hermes/hermes-agent
```

There is no override for managed paths, unknown versions, indirect paths or foreign databases.
All lifecycle code is pinned to the retained bundle; a changed checkout cannot operate an old
fixture unless its exact original bundle is used. Source/version mismatch still refuses; there
is no automatic update migration/reapplication. Run fixture entry points with `-I -B`; unexpected
payload/cache files refuse rather than becoming trusted code.

Install disables old grants and commits canonical phase denial before source mutation. File
replacement uses fsynced unique staging and atomic rename; the phase journal is separately fsynced.
Windows has no portable directory fsync, so no universal power-loss durability is claimed. Explicit
`recover` accepts only known adjacent DB/journal phases after verifying every allowed source/package
image. Interrupted install/remove/rollback and reinstall have fault tests. Unknown bytes or phases
refuse. Bounded non-executable staging orphans remain evidence; they are never imported, executed or
silently cleared. Mutation holds an exclusive fixture runtime lease; active/unknown executions,
workers or unacknowledged effects prevent removal. No database snapshot rollback occurs.

Disable revokes grants/registration and exact queued admissions while retaining canonical DB,
receipts, keys, revisions, custody and cancellation fences. It never certifies physical stop.
Removal has two explicit outcomes: with no v1 events, restore byte-identical base source and remove
the runtime package; with retained history, remove producer/activation code but retain the minimal
denial/receipt shim. Bare stock restoration with retained events refuses because it would strip
mandatory provenance from old receipts. The immutable bundle, original preimages and DB remain in
the fixture in both modes. The retained shim advertises nothing and authorizes no effect. A future
upstream migration of those retained fences needs a separate reviewed contract.

Before any coordinator-owned application: verify the exact commit, 15-file base pin, nine-file
postimages and candidate artifact hashes; review the diff and genuine native/consumer composition;
quiesce outside an active Ivy turn; preserve exact original bytes and canonical state; then verify
loaded code and functional foreground/profile boundaries. No hot patching or automatic reapplication
after an update is supported. Explicit `Host.detach()` durably disables producer registrations,
revokes grants and cancels exact queued v1 admissions while retaining all identity/effect records.
The live owner must use the tracked settlement port. Keep authenticated finish/inspect available
until outstanding custody is reconciled. Managed application/removal remains unapproved: disposable
fault/foreground tests do not qualify the real native verifier, consumer, full bootstrap or speech.
Unknown edits, mismatched hashes or lost custody stop removal; no timeout certifies stopped effects.
Do not delete schema/tombstones to free capacity or roll back a canonical database to resend events.

Ivy is the sole coordinated managed writer. Never restart the gateway/Desktop during an active
Ivy turn; arrange external handoff and preserve the conversation. Required critical independent
review, exact-schema consumer agreement, removal/foreground tests and an actual governed
named-Ivy ACP idle/concurrent lifecycle-to-visible-answer/speech-once demonstration precede
acceptance. The uncertain old #299 submission remains untouched. No merge/deploy is authorized.

## Native consent development boundary

The [passive native core](../../tools/native/consent-broker/src/lib.rs) supplies Rust-owned,
closed native-channel DTOs, direct duplicate-rejecting decoding, a bounded challenge lifecycle
and a code-set manifest validator. It is a separate dependency boundary for the future native
broker and Desktop client, with no Tauri registration or frontend IPC/binding change. No
positive production constructor exists: `Broker::unavailable()` returns `HostUnverified`.
Private, move-only attachment/callback/intent capabilities cannot be constructed by safe
external callers. Synthetic constructors and callback associations exist only under `cfg(test)`.
Rust privacy does not protect against malicious code inside the trusted process.

The candidate native-only wire frame is `{"method":"prepareConsent","params":{"session_id":"..."}}`,
or `completeConsent`/`cancelConsent` with only `challengeId`. Completion accepts no wire
`gestureProof`, PID, HWND, actor, transport ID or boolean. Response decoding is selected by the
outstanding request; arbitrary decoded DTOs are data, never authenticated trust evidence.
The semantic proposal's v1 result shapes and finite bounds remain unchanged. There is no
native pipe listener or callable live endpoint. The proposed local pipe and OS callback remain
design prerequisites, not capabilities supplied by these codecs.

Pending/confirming state is limited to 16 entries; all retained entries, including uncertainty
and cancellation fences, are limited to 64. The core refuses exhaustion and has no eviction or
reset API. It conservatively refuses a second challenge for the same attachment even after a
terminal state. There is no reauthorization, restart reconstruction or recovery operation.
Both wall and monotonic time bound confirmation. Scope/options, policy, attachment generation
and original connection are immutable; cancellation and invalidation fence late callbacks.
An internal grant intent is not a ticket. Reserving it changes state to uncertain before any
future host effect; failure cannot put it back into pending. No host approval/ticket adapter
is implemented. Downstream lost-bind uncertainty must remain durable in its existing owner;
the in-memory core supplies no authority to clear it after restart.

The code manifest explicitly identifies **code-set identity only**, not launch authorization,
immutability or attestation. It pins the existing baseline artifacts and lists 5–64 artifacts,
exactly one broker/Desktop/guardian/interpreter/host plus dependency entries. Relative ASCII
paths are at most 240 bytes; Windows device names, alternate streams, aliases, traversal,
case collisions and file/directory collisions refuse. Root programs are 1 byte–4 GiB; dependency
files may be empty (for example Python `__init__.py`). Each file is at most 4 GiB, total
at most 16 GiB; manifest input is at most 64 KiB. The validator checks metadata only and cannot
prove that a dependency closure is complete, that actual loaded bytes match, or that files
remain unchanged. No live gateway can be adopted by matching its PID, path or discovery file.

The proposed `cooperative-tcb-v1` boundary trusts the kernel and reviewed broker, guardian,
Desktop and host code/dependency/launch closure. It covers untrusted local callers and
model/tool/renderer automation. It does **not** protect against same-logon arbitrary code that
can alter/inject/debug a trusted process, substitute its code/environment, or control trusted
UI/accessibility/input injection. Native IPC identity and an OS verification result do not
close that gap or prove physical human input. Activation requires explicit acceptance of this
limited boundary or a separately qualified stronger isolation route. Development authorization
does not accept it for operation. The current mutable shared gateway is not qualified.

Future native launch custody must own a newly created, pinned gateway instance and retained
process/connection handles; validate both Desktop and selected host; fix interpreter flags,
module paths, dependency closure and environment; and forbid arbitrary discovery/adoption.
The exact launch recipe, private OS peer adapter, native affirmative scope UI, owned
`IUserConsentVerifierInterop::RequestVerificationForWindowAsync` callback and canonical host
adapter need separate critical review and qualification. No ordinary dialog, model text,
serialized verification result or fixture may replace them. Actual OS prompts, enrollment,
launch replacement, application and live qualification are not authorized by this change.
Issue #339 owns that broker/host boundary; #299 owns native client/UI and exact-operation
speech/renderer custody. Existing contract/interface hashes and installed capability remain
unchanged. See the [channel handoff](../../config/hermes-compat/native-consent/channel-v2.json)
for the immutable development surface and outstanding gates.

The separate `LaunchManifest` validator fixes a review recipe to exact validated CodeManifest
bytes. It names only unique guardian/interpreter/host roles; Python flags are exactly `-I -S -B`.
Module search, cwd, DLL search, environment and inherited handles have closed policy values;
arbitrary arguments/environment/paths and existing-gateway adoption refuse. `executionEnabled`
must be false. These policy strings do not enforce OS properties: no executor exists, the
current runtime has not qualified that recipe, and no fallback is allowed. Native launch and
custody implementation/qualification remain required before operation.

Identifier classification uses reproducible [Unicode-16 data](../../tools/native/consent-broker/data/printable-16.json)
from the pinned CPython baseline, not the Rust toolchain's potentially newer Unicode database.
The [stdlib-only exporter](../../tools/hermes-background/export_consent_unicode.py) checks every
code point and refuses a Unicode version change; `--check` verifies the committed bytes. The
challenge digest uses sorted compact UTF-8 JSON and a fixed cross-language vector. Neither
classification data nor test callback/digest fixtures attest a user or produce a real receipt.
