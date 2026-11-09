# Rust and Tauri boundaries

These contribution requirements govern Stellar native code. The desktop bootstrap supplies the Cargo workspace, pinned binding generator, AST-based size gate and Windows native CI targets. See the [desktop development guide](../guides/desktop-development.md) for setup and commands. [Epic #172](https://github.com/DanielssonThomas/Stellar/issues/172) owns subsequent native delivery.

## Module responsibilities

Keep `main.rs` and the application `lib.rs` as composition roots: initialize dependencies, register commands and run the application. Command handlers validate transport input, map types and delegate to feature behavior. They do not accumulate business rules, device management or unrelated operations.

Organize modules around cohesive features. Separate wire contracts, domain behavior and platform adapters within a feature when their responsibilities differ. Modules are private by default; expose only the interface another module needs. Do not create a catch-all `utils.rs`, a universal command dispatcher, or a global mutable singleton.

Domain logic must be testable without Tauri, a WebView or hardware. Pass dependencies explicitly; use small traits or functions where a real adapter or test seam needs them. Introduce a separate crate when an independently reusable boundary or dependency graph warrants one. Neither speculative abstractions nor one crate per file improves reuse.

The native host owns lifecycle and resource cleanup. Define who cancels background work, closes devices and removes subscriptions. Return typed errors at boundaries; do not panic on invalid user input. Keep locks short and avoid holding a synchronous lock across an await.

Angular application code remains composition. A shared adapter owns native calls and event subscriptions; presentational components consume semantic inputs. Existing Nx tags, public entry points, atomic layers and governed generators still apply. UI-only interaction, layout and animation state stays in TypeScript rather than being mirrored into Rust for uniformity.

## File size and readability

Count physical lines, including blank lines and comments, in each handwritten Rust source file. At 300 lines, a reviewer must assess responsibility boundaries and record the decomposition decision in the PR. More than 500 lines fails acceptance unless a file-specific exception has been approved and recorded here. Do not split a cohesive function mechanically or move behavior into macros to evade review.

Production and test lines are counted separately. In a mixed file, a Rust-aware counter must separate complete test-only items selected by `cfg(test)` from production items; ambiguous or mixed conditional items count as production. Dedicated test files count wholly as tests. Both counts use the same 300/500 thresholds. Moving tests out of a production module does not make their complexity exempt.

Generated and vendored source is excluded only through explicit paths with verifiable provenance and generation/vendor ownership. A filename or an author-written comment alone cannot establish an exclusion. The size gate tests boundary counts, mixed test items and exception handling. No tracked Rust source exclusion is currently approved. Include counts and any decomposition decisions in review evidence.

Exceptions belong in this document and require independent review appropriate to the changed-file risk. Each entry must name one exact repository-relative file, the count category, a numeric ceiling, the reason the module remains cohesive, alternatives considered, the authorizing issue/PR and a date or condition for reassessment. Review the exception in the same PR as the file, or before it. No wildcard, directory-wide or permanent blanket exemption is valid; a changed path, exceeded ceiling or elapsed reassessment condition requires a new review. No exceptions are currently approved.

Prefer descriptive names and focused functions to narration. Comments should explain what the code cannot communicate fully: a non-obvious invariant, external compatibility constraint, safety condition or reason for a decision. Public API documentation is appropriate when signatures do not fully describe units, ownership, failure behavior or lifecycle. Preserve license notices and generated-file notices. Do not add comments merely to label obvious steps.

## Rust-to-TypeScript contracts

Rust is the source of truth for types crossing the native IPC boundary: request/response DTOs, event payloads, enums and serialized errors. Keep internal domain types and platform handles out of that public contract. The selected generator produces TypeScript bindings behind a shared model library's public entry point; an adapter consumes those bindings. Never hand-edit generated files or maintain handwritten copies of backend types.

Define an explicit serialization contract, including stable field names and tagged enum representations. Record units, optional versus nullable fields, integer ranges safe for JavaScript and bounded payload sizes. Map native failures to a small typed error contract without leaking internal paths or sensitive data. Do not replace a growing enum with arbitrary strings or an `any` payload to avoid consumer changes.

Generated static types are not a runtime validator. Validate frontend input at native command boundaries and decode untrusted runtime payloads in the frontend adapter. Reject malformed input, unsupported contract versions and unknown variants intentionally. Use exhaustive handling for known variants; version mismatches produce a controlled compatibility error. Frontend and backend ship together in this milestone, so a new variant normally updates both in one PR. Any later independently updated consumer needs an explicit compatibility decision.

To extend a backend type, change the Rust definition, regenerate bindings with the pinned tool, update consumers and validators, then verify serialization fixtures and TypeScript exhaustiveness. Review the generated diff. Generation must be deterministic, run without a live application or microphone, and fail CI when committed output differs. Run `node tools/native/cargo.mjs contract-generate` to regenerate and the `stellar-desktop:contract-check` target to reject drift.

## Verification and native safety

New handwritten Rust crates forbid unsafe code by default. An unsafe requirement must be isolated behind a narrow, independently reviewed boundary with its rationale, invariants and tests recorded; do not weaken the default across the workspace. Review third-party native dependencies separately from this handwritten-code policy.

For a Cargo workspace, the required checks include:

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

These are baseline commands, not evidence that a workspace or toolchain is already installed. Pin the toolchain and dependency versions during bootstrap. Run the supported platform/feature combinations for changed code; mutually exclusive features do not justify blindly enabling every feature. Add meaningful domain tests, serialization fixtures and adapter lifecycle/error tests. Mock hardware at the adapter boundary, not by duplicating the implementation in a test.

Also run the actual repository binding-generation drift check, generated-consumer TypeScript checks, Rust file-size check and affected frontend checks once introduced. Native configuration, capabilities, IPC, packaging or device changes require an actual native smoke check on the supported platform. Browser Playwright and Tauri mocks cannot prove real WebView/device behavior. Record commands, versions, results and explicit skips, including the hardware-dependent verification still needed.

Keep Tauri capabilities and content policy explicit and minimal. Registering an application command does not by itself establish adequate authorization. Validate each privileged operation at its boundary; never accept arbitrary paths, shell commands or executable UI content as a shortcut. Credential access, protected governance and integration authority remain governed by the existing [engineering organization](../guides/engineering-organization.md), not by this document or an agent's generated plan.

Use the [Rust/Tauri workflow skill](../../.agents/skills/develop-rust-tauri/SKILL.md) alongside the normal issue and PR workflow. The [architecture overview](overview.md) remains the entry point for current implementation and governance.

## Machine-readable exception registry

### Manual microphone permission review interop

Issue #320 isolates unsafe Windows UI and WebView2 calls in `apps/stellar-desktop/src-tauri/src/microphone_permission/windows.rs`. The pinned Tauri safe API can answer new permission requests but cannot manage an existing per-origin browser permission/embargo. The documented [WebView2 profile permission API](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2profile4) supports deliberate user permission management; no raw profile file, OS setting, broad grant or browser testing override is used. The native module alone permits unsafe code; the composition root retains its default denial.

Tauri supplies the live reference-counted controller on its owning UI thread. Its source must be the exact main app origin both before the native dialog and immediately before the SDK call. Profile4 support is checked before asking the user. Only the owned native dialog's **Allow microphone** result can call `SetPermissionState` with the fixed `MICROPHONE` kind and `http://tauri.localhost` origin. Renderer requests contain only a contract version. Cancel is the default; closing, request cancellation, main-window destruction, app exit and the 120-second deadline cannot authorize a write. No mutex is held while the user chooses. The synchronous `TaskDialogIndirect` call keeps its UTF-16 literals, button array, output slot and stack callback data alive until every callback has returned. Its timer callback retains no pointer or HWND and can send only Cancel. COM interfaces remain on the UI thread; WebView2 retains the completion callback, which owns only a oneshot sender. `CoTaskMemPWSTR` frees every source string. A saved permission reply establishes neither effective OS permission nor successful capture; the user separately starts the existing selected source. The API's asynchronous completion is bounded, and a lost result is never replayed automatically.

Critical independent review of this exact adapter/exception and real native smoke are required before acceptance. Automated tests must not operate the consent dialog or change an existing profile's privacy state; live Allow/Cancel and selected-device capture qualification require the actual human. Reassess when changing Tauri, WebView2, Windows bindings, origin policy, callback ownership or dialog lifetime. This grants no file-size exception.

### Foreground process basename interop

Issue #301 isolates three unsafe Windows calls in `apps/stellar-desktop/src-tauri/src/awareness/windows_process.rs`: `OpenProcess`, `windows_core::Owned::new` and `QueryFullProcessImageNameW`. The existing windows-capture process-name helper requires process-memory read access and failed in native observation. Its capturability predicate also excludes legitimate foreground utility windows, so metadata observation uses the existing safe foreground/PID/title accessors and rechecks the PID without requiring screenshot eligibility. [Microsoft documents](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-queryfullprocessimagenamew) that image-name queries need only `PROCESS_QUERY_LIMITED_INFORMATION`. WinRT's alternative per-PID diagnostic API requires separate consent for other processes and is not used to bypass that boundary.

The adapter accepts only the already observed foreground PID, rejects zero, requests limited query access with handle inheritance disabled, and never enumerates processes, reads their memory, changes privileges or starts applications. A successful `OpenProcess` handle is uniquely owned by the windows-core RAII wrapper and closes on every return path. `QueryFullProcessImageNameW` receives a live 32,768-element UTF-16 buffer and its exact character capacity through an in/out `u32`; returned length is checked before decoding. The full local path is discarded and only its basename leaves this module. Access denial, invalid identity, malformed UTF-16 and exhausted capacity map to unavailable, with no raw OS errors or paths exposed. No pointer or handle escapes and no other module's unsafe policy changes. Critical independent review of this exact adapter and exception plus real native observation/smoke is required before acceptance; reassess when changing Windows bindings, requested access rights or buffer ownership.

### Windows playback volume interop

Issue [#286](https://github.com/DanielssonThomas/Stellar/issues/286) extends the same private `reflex/windows_volume.rs` boundary with per-session voice ducking through `IAudioSessionManager2`, `IAudioSessionControl2` and `ISimpleAudioVolume`. The worker retains apartment ownership and COM interfaces on one thread, releases each interface before its shared apartment guard, copies/frees every COM-allocated session identifier and bounds discovery to 256 sessions. Raw `GetProcessId` status preserves the distinction between single-process and ambiguous cross-process ownership; only Windows system sounds may use ambiguous ownership. The actual speech worker identifies its interpreter over the native-owned private pipe before audio dispatch; renderer input cannot select excluded process IDs. Session reads and finite 0–1 writes use unsafe interop; ducking never changes master endpoint volume or mute. Safe mixer/ramp modules own fades, session discovery, lease expiry, manual overrides and restoration; shutdown seals dispatch and joins the worker. Domain tests cover lifecycle and session changes. Native WebView smoke verifies validated IPC and unchanged master volume/mute; the opt-in real-session test verifies background attenuation and actual Ivy worker exclusion. Independent review of the extended unsafe boundary remains required before acceptance.

Issue [#271](https://github.com/DanielssonThomas/Stellar/issues/271) isolates Core Audio COM calls in `apps/stellar-desktop/src-tauri/src/reflex/windows_volume.rs`. Only this private module permits unsafe code for `IMMDevice::Activate<IAudioEndpointVolume>` and its scalar volume/mute methods. The existing WASAPI wrapper provides device enumeration and apartment setup but does not wrap endpoint volume. This boundary avoids global media key injection, screen automation and shell execution.

The caller owns an initialized MTA for the whole operation. Reference-counted COM interfaces remain local; no raw pointer escapes. The null event-context GUID is an optional Windows parameter. Requests target the inspected default render endpoint, recheck its identity and values, clamp adjustments to ten percentage points within 0–100, and require readback. The native host serializes the synchronous operation start against cancellation, then releases its lock before waiting/readback. Window destruction and exit seal dispatch. Independent review of this exact module and safe native read-only/invalid-ticket smoke passed during #271; repeat review and native qualification when changing the Windows/WASAPI bindings or this boundary. No other unsafe or file-size exemption is introduced.

### WebView2 focus interop

Issue #257 introduces one narrowly scoped unsafe block in `apps/stellar-desktop/src-tauri/src/media/browser_focus.rs` for WebView2’s `ICoreWebView2Controller::add_GotFocus`, `CoreWebView2` and `ICoreWebView2::add_SourceChanged`. Tauri does not expose child focus through its general webview events. Native source events cover fragment and SPA history changes. Native focus is required to keep actual webpage clicks and workspace selection synchronized without granting websites application IPC or trusting page messages. The desktop entry point denies unsafe code by default; only this private Windows module permits it. Other crates retain their existing default prohibition.

Tauri supplies the live reference-counted controller on its owning UI thread. Registration receives valid stack token pointers; WebView2 retains the reference-counted handler until controller closure. The callback captures only application/event ownership and no COM controller or raw pointer. Setup awaits the registration result and closes the child on failure. The event selects only that controller's pane; it neither executes a tool nor grants remote capabilities. Independent review of this exact module, a real native focus/IPC probe, and reassessment when upgrading Tauri, Wry or WebView2 bindings are required before acceptance. This exception changes no Rust file-size ceiling or unsafe policy outside this module.

The Rust-aware size gate reads this registry; no source exclusions or exceptions are currently approved.

<!-- rust-size-exceptions:start -->

```json
[]
```

<!-- rust-size-exceptions:end -->
