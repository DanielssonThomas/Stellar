# Rust and Tauri boundaries

These are contribution requirements for native code introduced into Stellar. The desktop application, Cargo workspace, binding generator and native CI targets are not implemented by this document. [Epic #172](https://github.com/DanielssonThomas/Stellar/issues/172) owns delivery; its feasibility spike selects compatible tooling and its bootstrap installs enforcement. Until then, reviewers apply these rules directly and report unavailable automation rather than claiming it passed.

## Module responsibilities

Keep `main.rs` and the application `lib.rs` as composition roots: initialize dependencies, register commands and run the application. Command handlers validate transport input, map types and delegate to feature behavior. They do not accumulate business rules, device management or unrelated operations.

Organize modules around cohesive features. Separate wire contracts, domain behavior and platform adapters within a feature when their responsibilities differ. Modules are private by default; expose only the interface another module needs. Do not create a catch-all `utils.rs`, a universal command dispatcher, or a global mutable singleton.

Domain logic must be testable without Tauri, a WebView or hardware. Pass dependencies explicitly; use small traits or functions where a real adapter or test seam needs them. Introduce a separate crate when an independently reusable boundary or dependency graph warrants one. Neither speculative abstractions nor one crate per file improves reuse.

The native host owns lifecycle and resource cleanup. Define who cancels background work, closes devices and removes subscriptions. Return typed errors at boundaries; do not panic on invalid user input. Keep locks short and avoid holding a synchronous lock across an await.

Angular application code remains composition. A shared adapter owns native calls and event subscriptions; presentational components consume semantic inputs. Existing Nx tags, public entry points, atomic layers and governed generators still apply. UI-only interaction, layout and animation state stays in TypeScript rather than being mirrored into Rust for uniformity.

## File size and readability

Count physical lines, including blank lines and comments, in each handwritten Rust source file. At 300 lines, a reviewer must assess responsibility boundaries and record the decomposition decision in the PR. More than 500 lines fails acceptance unless a file-specific exception has been approved and recorded here. Do not split a cohesive function mechanically or move behavior into macros to evade review.

Production and test lines are counted separately. In a mixed file, a Rust-aware counter must separate complete test-only items selected by `cfg(test)` from production items; ambiguous or mixed conditional items count as production. Dedicated test files count wholly as tests. Both counts use the same 300/500 thresholds. Moving tests out of a production module does not make their complexity exempt.

Generated and vendored source is excluded only through explicit paths with verifiable provenance and generation/vendor ownership. A filename or an author-written comment alone cannot establish an exclusion. The bootstrap must test boundary counts, mixed test items and exclusion/exception handling before activating the automated check. Until then, include the counts and any uncertainty in the review evidence.

Exceptions belong in this document and require independent review appropriate to the changed-file risk. Each entry must name one exact repository-relative file, the count category, a numeric ceiling, the reason the module remains cohesive, alternatives considered, the authorizing issue/PR and a date or condition for reassessment. Review the exception in the same PR as the file, or before it. No wildcard, directory-wide or permanent blanket exemption is valid; a changed path, exceeded ceiling or elapsed reassessment condition requires a new review. No exceptions are currently approved.

Prefer descriptive names and focused functions to narration. Comments should explain what the code cannot communicate fully: a non-obvious invariant, external compatibility constraint, safety condition or reason for a decision. Public API documentation is appropriate when signatures do not fully describe units, ownership, failure behavior or lifecycle. Preserve license notices and generated-file notices. Do not add comments merely to label obvious steps.

## Rust-to-TypeScript contracts

Rust is the source of truth for types crossing the native IPC boundary: request/response DTOs, event payloads, enums and serialized errors. Keep internal domain types and platform handles out of that public contract. The selected generator produces TypeScript bindings behind a shared model library's public entry point; an adapter consumes those bindings. Never hand-edit generated files or maintain handwritten copies of backend types.

Define an explicit serialization contract, including stable field names and tagged enum representations. Record units, optional versus nullable fields, integer ranges safe for JavaScript and bounded payload sizes. Map native failures to a small typed error contract without leaking internal paths or sensitive data. Do not replace a growing enum with arbitrary strings or an `any` payload to avoid consumer changes.

Generated static types are not a runtime validator. Validate frontend input at native command boundaries and decode untrusted runtime payloads in the frontend adapter. Reject malformed input, unsupported contract versions and unknown variants intentionally. Use exhaustive handling for known variants; version mismatches produce a controlled compatibility error. Frontend and backend ship together in this milestone, so a new variant normally updates both in one PR. Any later independently updated consumer needs an explicit compatibility decision.

To extend a backend type, change the Rust definition, regenerate bindings with the pinned tool, update consumers and validators, then verify serialization fixtures and TypeScript exhaustiveness. Review the generated diff. Generation must be deterministic, run without a live application or microphone, and fail CI when committed output differs. The bootstrap supplies the repository command; do not invent a currently available command in documentation.

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
