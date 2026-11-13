# Proposed native consent integration v3

Status: **DESIGN FOR CRITICAL REVIEW, NOT IMPLEMENTED OR USER-ACCEPTED TRUST**. This is an additive proposal following producer `550bc3014ef93e444644d9c9a2ab88704fa1ceb3` and consumer local-only `a5fd4c70c268bba4abd18bc2c7f5a37ffc9bf9a6`. No operational constructor, endpoint, prompt, launcher, managed change or capability is introduced. Existing contract/interface/proposal/channel-v2 bytes and hashes remain unchanged.

## Choice and ownership

Choose a **guardian-owned native window in the guardian process**, linked from a #299-owned native UI crate. The #339 guardian hosts broker state, OS verification and canonical-host adapter. The UI component supplies presentation and resource lifetime, not user-verification authority. Desktop is a separate native client and never supplies HWND, a gesture proof or a serialized OS result. This avoids cross-process HWND/WinRT ownership and leaves native client/UI ownership with #299.

| Exclusive owner | Proposed files                                                                                                                    | Responsibility                                                                                                                  |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| #339            | `tools/native/consent-broker/src/{guardian,windows_verifier,attachment,consent_journal}/**`                                       | Guardian composition, retained OS/process/channel custody, OS callback association, consent lifecycle                           |
| #339            | `config/hermes-compat/stellar-background-v1/stellar_background/{native_attachment,native_consent}.py`                             | Private canonical connection registration, same-DB consent fences and host ticket/bind adapter                                  |
| #339            | additive compatibility manifests, exporter/package postimages and owning architecture                                             | Pinned candidate and refusal/disable/removal; future changes need renewed review                                                |
| #299            | new `tools/native/consent-ui/**`                                                                                                  | Native Win32 scope window, literal display, affirmative/cancel events, RAII window lease; no OS verification or ticket minting  |
| #299            | `apps/stellar-desktop/src-tauri/src/ivy/{native_consent_client,process,lifecycle_consent,lifecycle_ports}.rs` and its bridge code | Native-only client, inherited bridge attachment, original selected session, transient ticket-to-bind, local durable uncertainty |
| #299            | existing speech/renderer/monitor modules and generated app IPC, if needed                                                         | Exact local operations, stop/finish proof, freshness, view generation; no producer edits                                        |

These are proposed exclusive paths, not permission to edit another worktree. Ivy relays acceptance/amendment and reconciles shared crate dependency changes; #339 owns root Cargo/lock changes for the guardian. #299 owns its app manifest. New UI crate must not depend on broker, avoiding a dependency cycle: its UI-only view model is not a wire contract. Guardian maps trusted prepared scope to that model. No parallel edits to shared manifests.

## Trust root and explicit non-goal

`cooperative-tcb-v1` remains **PROPOSED, NOT USER ACCEPTED**. Kernel, reviewed guardian/Desktop/bridge/host code, all executable dependencies, launch policy and coordinator-selected release-policy bytes are TCB. An operator-approved release policy is an explicit external trust assumption, not something established by a matching digest, caller CLI option, manifest file, parent PID or named-pipe nonce. No current approved policy source exists. Neither process may accept a policy supplied over its client RPC or auto-enroll observed bytes. No signing key, enrollment, credential, admin privilege or policy installation is assumed available.

Untrusted callers/model/tool/plugin/renderer request text and replay cannot select authority. Same-logon arbitrary code able to alter/inject/debug the TCB or replace its code/environment/policy, or control trusted UI/accessibility/UIAccess/input injection, remains unsupported. This design supplies no stronger guarantee than the prior proposal: OS user verification is not transaction signing, Python-code attestation or proof of physical human input. Native button events are not physical-presence evidence. All in-process Python plugins/importable executable code must be included in the trusted closure; Python privacy does not isolate malicious plugin code.

Before operation the coordinator must separately accept this boundary and a concrete external release-policy custody source, or choose stronger separately reviewed isolation. Development/design review cannot do that. Without an accepted root, both sides return HostUnverified; there is no fallback to discovered mutable Hermes or path checks.

## Launch and two-sided attachment

Proposed future graph: coordinator starts guardian; guardian starts exactly one pinned canonical host, one pinned bridge and one pinned Desktop. Retain process/thread handles returned by creation, creation times, logon/session association and exact approved image identity; never reopen/adopt by caller PID. Guardian provisions one native-client channel, one host-authority channel and one canonical bridge-host channel. It passes only explicit endpoint/process handles using STARTUPINFOEX handle allowlists; inherited objects are process-local, never deserialized into authority from integers in RPC. No general handle inheritance, arbitrary argv/env, existing Desktop/bridge/gateway adoption or mtime-selected facts.

The approved release policy must identify all four binaries/bootstrap inputs, baseline pins, OS/build and code closure, not merely python.exe. CodeManifest/LaunchManifest v2 remain review metadata and still require executionEnabled=false. A future separate runtime release-policy type is required, not relaxation of those validators. It fixes interpreter `-I -S -B`, pinned bootstrap, fixed module roots, OS-derived SystemRoot and guardian-private scratch, private cwd/DLL policy and handle list. Current Hermes has not qualified this recipe, its real dependency closure or foreground MCP; unknown imports or incompatible bootstrap refuse, never relax flags.

The v2 64-artifact metadata bound cannot by itself list every Python/OS module. A proposed v3 release policy binds a closed closure-index artifact (itself a dependency entry), <=16MiB and <=32768 unique Windows-safe file entries, each exact root/path/length/SHA256; roots are fixed selected-runtime, candidate-host, native-release and OS-system roots. No arbitrary root/path, junction/symlink/hardlink alias, executable cache or unindexed loaded module. OS files/build are pinned too; OS/runtime update mismatch refuses. Verify on-disk inputs before child creation and loaded image/module provenance before attachment and before trust-sensitive dispatch. TCB tampering between checks remains explicitly outside this cooperative boundary; these checks do not claim immutable execution or remote attestation. Full loader/closure implementation needs its own critical review, not a generated manifest assertion.

Use local named pipes with explicit same-logon DACL, reject remote clients, bounded instances and first-instance collision refusal. Both endpoints check kernel-reported pipe peer PID against their retained expected process handle/creation time/liveness, expected token logon/session and approved launch/code identity. PID/path alone is never sufficient. No impersonation, elevation or token/credential duplication is required. The host-authority pipe accepts only guardian; the native-client pipe accepts only the one retained Desktop; the canonical pipe accepts only the retained bridge. Child-side guardian identity is checked against the independently provisioned approved release policy, not self-reported policy fields. Pipe paths/nonces are discovery hints, not credentials.

Host bootstrap captures the actual accepted bridge canonical connection object into a private `NativeConnectionLease`. The one authority-channel instance closes over that lease and its Desktop/bridge/guardian/host lifetimes, so authority messages need no caller-selected attachment/transport ID. Native legacy owner registration alone is insufficient. The canonical host's verify_native gate requires exact object identity, not actor equality, plus current lease generation/epoch and live retained peers. Bridge-host reconnect makes a new untrusted connection; it cannot inherit the old lease, ticket or effect custody. A replacement launch cannot clear a durable uncertain attempt.

This mode would eventually replace the current startup graph on the **main selected managed runtime**, after coordinated quiescence and approval, not create an alternate production install. No such start or replacement is authorized now. Existing foreground startup stays unchanged and native capability withheld until that separate integration gate.

The **final server process creates** each named-pipe instance and the final client opens it after startup rendezvous:

| Pipe           | CreateNamedPipe owner | Opening client | Required reciprocal kernel observation                                 |
| -------------- | --------------------- | -------------- | ---------------------------------------------------------------------- |
| native-client  | Guardian              | Desktop        | Guardian observes retained Desktop; Desktop observes retained guardian |
| host-authority | Canonical host        | Guardian       | Host observes retained guardian; guardian observes retained host       |
| canonical      | Canonical host        | Bridge         | Host observes retained bridge; bridge observes retained host           |

Inherited bootstrap mappings/process handles carry only allowlisted rendezvous/expected-peer references. They are not final connected named-pipe endpoints, and inheritance must never be claimed to change a pipe's peer PID to the inheriting child. Verify identity again on the final opened connection; failure closes it before registration. Guardian-created anonymous stdio pairs join its bridge and Desktop, with unused parent ends closed after provisioning. Their identity derives from the proposed trusted launch/explicit handle custody, not a fictitious fresh kernel peer-PID observation. They provide no separate adoption or authority-registration API.

The strict no-hardlink OS closure is explicitly **unqualified**: normal serviced Windows files may be WinSxS hardlinks. Future loader review must either demonstrate that strict recipe works for the chosen inputs or define a separately reviewed OS-only canonical file-identity/approved-alias policy. It must not silently ignore link counts, exempt arbitrary OS paths or weaken application-root alias checks. This design introduces no such exception.

## Native window and OS callback custody

#299 UI crate proposed native-only API:

```text
ScopeWindow::present(GrantView) -> OwnedScopeWindow | UiError
OwnedScopeWindow::next_event() -> Affirmed | Cancelled | Destroyed
OwnedScopeWindow::borrow_hwnd() -> lifetime-bound HWND borrow
OwnedScopeWindow::close() -> closure observation, not consent/revocation proof
```

GrantView is immutable literal display data mapped by guardian from the host-captured original profile/conversation/producer, effects render+speech, exact expiry and admission budget. No model/history/HTML/renderer string may select scope. UI crate stores its immutable view association and window generation; its HWND cannot escape as a client RPC field. UI events are requests, not Verification objects. Native view data is UI-only; all wire DTOs remain Rust-owned in broker. No UI crate API mints a broker Attachment, Verification, GrantIntent or ticket.

Guardian reserves confirming state before showing one native window; a concurrent complete returns Busy. On the actual native Affirmed event guardian rechecks owned window generation/current-process HWND and active application window, exact immutable scope digest, original host scope/policy/connection and deadlines. It then invokes `IUserConsentVerifierInterop::RequestVerificationForWindowAsync` **in the guardian process on its owned active window**. Windows build22000+ and available verification device are required. No foreign HWND, foreground stealing, Forms fallback, password/key access, enrollment or automatic retry. If an owned active window cannot be obtained, refuse VerificationUnavailable without a prompt.

Only that private OS callback returning Verified, still associated with the owned window/challenge/digest/generation and the prior affirmative action, may construct private Verification. It is not exposed to UI/renderer/ordinary RPC. Release UI/ledger locks before awaiting WinRT; an independent control reader must service cancel while the OS flow is pending. Premature window destruction during an outstanding flow, attachment loss, policy/origin change or expiry invalidates callback generation before any ACK. Best-effort OS cancellation/window close is not proof the OS prompt was dismissed. A late Verified grants nothing. The actual OS call and unsafe HWND/COM lifetime boundary require exact code/exception review and later authorized native qualification; this document does not approve invoking them.

### Window retirement versus loss

Unexpected destruction while pending/confirming, while the OS operation is outstanding, or while consumeConsent is unresolved invalidates the callback and sends ordered host cancellation. It cannot release a ticket. A normal successful teardown is different: only after genuine callback consumption **and a known successful host consume reply** may guardian atomically enter `ui_retirement_authorized`, invalidate further UI affirmation callbacks, close its own window and observe closure, then enqueue the one complete result. A failed/unknown close or lost host reply yields Uncertain, with no result reissue. User close before this transition is cancellation, never authorized retirement.

After that deliberate retirement, bind requires live process/channel/lease and original scope/policy/ticket journal predicates, **not a still-open confirmation HWND**. The retained internal confirmation/retirement state is not a caller boolean and cannot be recreated after crash. A late Destroyed event for that exact intentionally retired generation is resource cleanup, not an automatic grant revocation; a different generation or premature loss is not exempt. Subsequent opt-out or actual peer/channel loss still denies/revokes under host rules. No callback is accepted from a destroyed window, and normal close cannot resurrect a consumed callback. This explicitly narrows the outstanding-window-loss rule, without changing any baseline file.

## Exact native-client channel

Existing v2 request/result **inner shapes stay semantic baseline**: prepareConsent({session_id}); completeConsent({challengeId}); cancelConsent({challengeId}). No gestureProof/Verified/actor/transport/PID/HWND inputs. Result/error fields and limits remain in channel-v2.json. #299 already accepts proof-free complete in its a5fd4c7 handoff; that semantic agreement is not operational acceptance.

Proposed v3 framing adds correlation required for concurrent cancellation. Each payload is length-prefixed u32 little-endian followed by <=16384 UTF-8 JSON bytes, no trailing data/duplicate or unknown keys:

```text
request  = {version:3, sequence:safePositiveInteger, request:{method,params}}
success  = {version:3, sequence:same, result:<exact method result>}
failure  = {version:3, sequence:same, error:{code:<v2 error enum>,retryAuthorized:false}}
```

Strict per-channel request sequence starts1 and advances by1; terminal replies may arrive out of order but must match an outstanding method/sequence once. Max4 outstanding including reserved cancel slot, <=1 complete; reader never queues cancel behind a pending prompt. Malformed/replayed/conflicting frame closes the attachment and fences pending/uncertain work; no resend. Control cancel may invalidate the challenge; it never certifies binding revocation or stopped effects. Complete timeout/lost ACK remains uncertain with no new challenge/ticket/rebind. Decode success/ticket does not itself authenticate a connection.

Desktop native adapter captures selected session and actual existing Broker connection locally; no WebView-supplied consentTicket. It calls prepare, compares fixed Ivy/original session and scope, requests complete, and transfers the transient native-only result immediately into existing `stellar.background.bind(session_id,consentTicket)` on the **same original canonical bridge transport**. Ticket is not persisted in renderer state, logged or sent over ordinary approval/dialog routes. No capability advert is enabled by handshake/schema agreement.

## Private host-authority port and durable ticket adapter

`preparedDigest` is exactly SHA256 of the recursively sorted, compact, UTF-8 canonical Prepared v1 result (ensure_ascii=false; no normalization); it is hex64, not a bearer proof. This cross-process scope-equality digest is distinct from the broker's existing policy/generation-bound internal callback digest, which remains unchanged. intentId/challengeId are hex64. Trusted policy/generation/actual connection are additionally checked from the private lease, never inferred from this digest.

The native-client and host-authority channels use the new v3 control framing. The canonical bridge-host channel retains the pinned existing canonical gateway request/event codec and limits, including foreground behavior; it does not adopt the 16KiB native-control envelope. A new private named-pipe transport adapter must instantiate the actual canonical connection under the registered lease rather than duplicating admission/event semantics or parsing caller actor claims. Its implementation and ordinary foreground/profile regression checks remain gates.

Private bootstrap authority port, never registered in ordinary gateway/model/plugin RPC, has the same bounded correlated framing. Its authenticated handler closes over the NativeConnectionLease. Exact methods/params:

| Method         | Closed params                             | Result                                                                                                    |
| -------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| reserveConsent | `{session_id}`                            | exact Prepared v1 scope; host chooses registered producer/options, random challenge and connectionBinding |
| beginConsent   | `{challengeId, preparedDigest}`           | `{confirming:true}` after durable reserve                                                                 |
| consumeConsent | `{challengeId, preparedDigest, intentId}` | `{consentTicket}` after original-lease-bound issuance                                                     |
| cancelConsent  | `{challengeId}`                           | `{cancelled:true}` only for pending/confirming, invalidated before ACK                                    |

`intentId` is guardian-generated hex64, reserved once only after the actual owned callback; no OS result/proof boolean is sent. An authenticated guardian message is an attestation by the proposed trusted guardian code, **not self-authenticating JSON**. Host checks source channel/retained peer/launch policy, durable known challenge/confirming state/digest/sequence and original live lease. Only then can the host private handler create a non-serializable one-use HostGrantProof. It cannot be reconstructed from ordinary request fields or caller-provided Python truthy objects. If that authenticated attestation/TCB root is unavailable, deny. Private verifier factories remain sealed from safe external callers; malicious TCB code is outside the proposed boundary.

Proposed consent journal is **in the existing canonical DB**, not another execution queue. New versioned tables retain challenge/attachment/launch generation, authority epoch, exact prepared scope/digest/policy, consent revision/options, state, ordered cancel/intent reservation and optional bound bindingId. Pending<=16, retained attempts<=64, one attempt per attachment; no eviction/reset/automatic reauthorization. DB schema/migration/code must receive independent critical review before implementation. Persist fences before outbound ACK/OS request/ticket side effect. No model execution is admitted by these tables.

Issuance ordering: validate lease+scope/policy in host owner loop; durable confirming->issuing reservation; create private HostGrantProof tied to actual connection object and prepared scope; call host-only Host.approve once; record issued/ticket hash (never raw ticket in journal), then reserve release only to the original native attachment. Failure/crash at any step retains issuing/uncertain; never reconstruct/release a ticket again. Host is the ONLY consent-journal writer. Its durable begin row fences the entire OS attempt before the prompt; guardian consumes callback/intent in memory before sending consume and cannot resume/reconstruct that capability after crash. No second guardian DB/journal writer is introduced. A confirming row from an interrupted guardian remains a retained unresolved fence, never permission to start another attempt.

Cancellation and bind share one canonical transaction domain. Every cancellation records a sticky `deny_requested` fence on the attempt. If pending/confirming, commit cancellation before ACK and invalidate the native callback. If issuing/issued/bound, do not report successful rollback: return Uncertain/revoking while retaining the fence. If bind won, the cancellation transaction also sets that exact resulting binding revoked and reserves existing cancellation/cleanup obligations atomically. If cancel won, every later issuance-state transition, release authorization and bind must observe the fence and refuse; no later success clears it. The bind transaction atomically checks no deny fence, exact live lease/scope/policy and unconsumed issued state, then inserts the binding/owner and consumes the ticket row. A separate query-then-revoke is forbidden. Release authorization is reserved in this ordered DB domain before enqueueing bytes; already queued ticket bytes cannot be recalled and may arrive after cancel, but the sticky fence still denies bind. Neither DB commit nor an IPC ACK proves physical stop or atomic DB+pipe delivery.

Required changes to current Host code are explicit: ticket record must retain **exact connection object/lease generation**, not only actor equality; approve must compare the freshly captured Origin to Prepared; bind revalidates exact native lease, physical target/profile/route/producer/incarnation/policy and ticket deadline. Binding DB commit must atomically consume issued journal row and insert ordinary binding/owner using the existing ledger transaction hook plus the sticky cancellation predicate above. Concurrent duplicate bind must not create another revision/binding; lost bind ACK remains uncertain and no recovery/resend API is introduced. In-memory ticket loss on restart does not erase durable attempt fences. Existing admission/receipt/effect custody journals and old #299 uncertainty remain untouched.

Reset/compression, opt-out, peer loss, premature outstanding-window loss and policy change deny before issuance/bind and at dispatch/delivery under existing v1 gates. Deliberate consumed-phase UI retirement follows the rule above and is not such loss. Registration teardown retains inspect/finish access for original outstanding custody; it does not transfer it to a new transport. No timeout proves speech/render/worker stop. #299 a5fd4c7 exact speech handle/cleanup is useful inactive code, not audibility or smoke acceptance. Its capturedWindow smoke failure remains an independent required qualification issue.

### Cross-launch uncertainty exclusion

Use a stable **profile-wide native-consent exclusion key**, `profileId=ivy`, independent of attachment ID, process IDs, authority epoch, connection generation or launch nonce. reserveConsent checks the canonical DB for any unresolved prior consent attempt under that key in the same transaction as reserving a new attempt. Any pending/confirming/issuing/issued/uncertain/revoking attempt, or a bound attempt with unretired grant/custody, refuses Uncertain; a fresh process/epoch cannot bypass it. The current attempt's later begin/consume/cancel uses its exact ID and does not reserve again. This is deliberately conservative: concurrent prompts on another session of Ivy also refuse.

No timeout, process exit, new launch, missing in-memory ticket, absence of a new registry, expired ACK deadline or DB row deletion resolves that fence. No endpoint in this proposal retires an unresolved attempt or reauthorizes it. A future explicit terminal-resolution/reauthorization contract must prove no outstanding ticket/binding/effect/UI authority, revoke as needed in the same transaction domain and preserve tombstones before releasing exclusion; until separately reviewed, cross-launch attempts remain refused. This adds no recovery command or resend authority and never examines/clears the old uncertain #299 submission as permission for a new one.

## Review and implementation gates

1. Critical design review of this exact proposal: root-of-trust assumptions, guardian-owned HWND/native UI split, channel association, host transaction/cancel/uncertainty ordering, closure limits and exclusive paths. This is technical review, never user TCB acceptance.
2. Ivy relays exact file/API partition to #299; accepts/amends the **guardian-hosted #299 UI crate** arrangement and v3 correlation envelope. This is the smallest coordination choice needed before implementing those shared ports. It changes no original v1 descriptor/receipt/effect schema or baseline pins.
3. Implementation may proceed only within reviewed development scope after the applicable design/partition agreement; keep production constructors unavailable and no app registration. Separate reviews for Windows unsafe lifetimes, release-root loader/closure, two-sided attachment and canonical journal/ticket adapter; generated app IPC belongs #299. Unit/disposable process tests do not invoke Hello or use real journals.
4. Native qualification needs a later specific authorization: genuine scoped native UI/OS callback and wrong-window/peer/lifetime/cancel/expiry checks, main runtime closure/profile MCP preservation, capturedWindow smoke, descriptor/replay/receipt and actual idle/concurrent delivery/effect custody. No real prompt is authorized now.
5. Operation additionally needs explicit user acceptance of the proposed TCB/policy custody boundary and separate coordinated managed application/quiescence/start authorization outside active Ivy turn. No merge/deploy authorization follows.

## Smallest next decision, command and side effects

No generic installation approval is requested. Ivy can relay this exact DEVELOPMENT disposition: **“Accept guardian-owned HWND/OS callback, #299-owned native consent-ui crate, v3 correlated envelope and exclusive paths for inactive development only; cooperative TCB remains proposed and all operational gates remain closed.”** If #299 requires Desktop-hosted UI, return that single delta; redesign verifier hosting, not cross-process arbitrary HWND or serialized Verified proof. No OS trust acceptance is implied by either choice.

Current executable command (safe, no launch or prompt):

```powershell
# In #339 with the existing pinned toolchain environment:
cargo test --offline --locked -p stellar-consent-broker
```

It compiles/runs the existing passive domain and compile-fail tests and writes only build output; it establishes no operational verifier. Normal same-session claim helper is used before later implementation, not a new identity.

Proposed future operational command is **NOT IMPLEMENTED AND MUST NOT BE RUN**:

```text
stellar-consent-guardian start-approved
```

It deliberately accepts no policy path/hash/PID/argv flags. If eventually implemented and separately authorized, it would read the fixed externally accepted release-policy source, verify pinned main runtime/closure, require prior main gateway quiescence, start the four-process owned graph, create private IPC, open existing canonical DB and create new consent-attempt fences. A user-requested complete would show the native scope window and OS verification prompt. It would not enroll credentials or delete old journals. The approved-root source and deployment binding are absent, so the current required behavior is HostUnverified and **no side effects**. This spelling is a concrete proposed interface, not an available CLI or present permission to replace a gateway.

## Primary evidence

- [Microsoft owned application-window verification API](https://learn.microsoft.com/en-us/windows/win32/api/userconsentverifierinterop/nf-userconsentverifierinterop-iuserconsentverifierinterop-requestverificationforwindowasync): active application HWND, OS result, build22000 minimum; does not document transaction signing.
- [Microsoft pipe client identity](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getnamedpipeclientprocessid) and [server identity](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getnamedpipeserverprocessid): PID observations, not code provenance.
- [Microsoft handle inheritance](https://learn.microsoft.com/en-us/windows/win32/procthread/inheritance): explicit handle-list option and inherited object behavior; does not confer application authority.
- Current producer Host stores actor-only tickets; consumer a5fd4c7 owned bridge selects Python by mutable facts and discovers separate host. Neither is already this launch/attachment path. No source/fixture is promoted into an operational trust anchor.
