# ADR 0003: Desktop native contracts and capture feasibility

**Status:** Partially verified, 1 November 2026. Native contract generation and both Windows content origins are verified. Physical microphone acceptance remains pending; this decision does not claim completion of every #175 hardware scenario.

## Context

Stellar needs a genuine Windows desktop host with extensible Rust-to-TypeScript contracts and opt-in local sound activity. The existing Angular browser tests cannot establish native WebView or physical microphone behavior, so an isolated probe tests those boundaries before product integration.

## Decision

Use Tauri 2 with an Angular frontend for the desktop host. Rust owns native wire contracts; use pinned `ts-rs` generation for their TypeScript representations, with separate runtime validation at both boundaries. Keep interaction and presentation state in reusable TypeScript libraries.

Use Web Audio as the candidate capture adapter for the first sound-activity milestone. The Windows WebView exposes a secure context, `mediaDevices` and `AudioContext` in both tested origins. Availability of these APIs is not evidence that microphone permission, acquisition or device removal works. Keep capture opt-in and isolated behind an adapter until physical checks establish those behaviors. Do not introduce a Rust audio dependency merely to compensate for an unperformed hardware test.

## Evidence

The isolated [desktop probe](../../tools/desktop-probe/README.md) uses Rust 1.99.1, Tauri 2.12.5, tauri-build 2.7.4 and ts-rs 12.0.1. It separates contracts, pure domain validation, command/event composition and frontend decoding. Its Foreman contribution has a recorded session receipt; Codex applied and verified the source.

Actual native windows were inspected through Windows accessibility on Windows 11 Home, build 26200, with WebView2 Runtime 156.0.4314.50:

| Content mode                              | Observed origin          | Contract result            |
| ----------------------------------------- | ------------------------ | -------------------------- |
| Embedded local assets (`custom-protocol`) | `http://tauri.localhost` | Passed, two events, 72 ms  |
| Local development server                  | `http://127.0.0.1:1425`  | Passed, two events, 102 ms |

Both windows round-tripped an optional device label, a tagged state and `18446744073709551615` as a decimal string, and displayed the typed unsupported-version error. These elapsed values describe single probe runs, not a performance benchmark. Both origins reported `secureContext: true`, available media devices and a functional AudioContext constructor. Capture remained idle during these inspections.

The probe's Rust domain/serialization suite passed 10 tests, frontend suite passed 9 tests, and clippy passed with warnings denied. These checks cover meaningful contract and cleanup behavior but do not replace physical microphone checks. The probe README owns repeatable commands and current verification details.

## Consequences

Keep JavaScript-unsafe integers serialized as decimal strings. Optional fields, tagged enums, error variants and schema-version checks are explicit. Generate types deterministically and check for drift; adding a Rust enum variant requires updating exhaustive consumers and runtime decoders in the same change.

`ts-rs` does not encode serde's exact-object rejection in the TypeScript type system. The probe retains explicit runtime validation and negative serialization tests. Empty struct variants are used where serde unit variants would otherwise accept unexpected fields.

## Remaining acceptance

The first user-driven microphone attempt reported no visible activity while speaking and an unwanted console window. The debug GUI subsystem setting was corrected. The audio cause is still unconfirmed: the revised probe exposes dBFS, precise RMS, peak, frame count, context and track state, plus explicit input selection. Context resume begins within the Start gesture. The first attempt is a failed activity observation, not a successful capture qualification.

User-driven opt-in, permission denial, device absence/removal, retry and release of the operating-system microphone indicator still require observation in the embedded and development windows. No audio is recorded or transmitted by the probe. Tests using synthetic sources cannot establish physical device behavior.

The desktop bootstrap must carry the verified modular boundaries into the governed Angular application, add native CI and size enforcement, and keep the isolated probe out of the product interface. Browser Playwright remains useful for deterministic UI behavior; actual Windows native inspection remains required for capabilities, IPC and capture changes. A release installer was not built or qualified by this probe.

## Related references

- [Native feasibility issue #175](https://github.com/DanielssonThomas/Stellar/issues/175)
- [Rust and Tauri architecture requirements](../architecture/rust-tauri.md)
- [Desktop probe source and repeatable checks](../../tools/desktop-probe/README.md)
