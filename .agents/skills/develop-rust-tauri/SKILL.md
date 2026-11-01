---
name: develop-rust-tauri
description: Implement or review Stellar Rust modules, Tauri commands and adapters, or Rust-generated TypeScript IPC bindings within an assigned issue.
---

# Develop Rust and Tauri changes

Use this skill within [implement-issue](../implement-issue/SKILL.md), not as a replacement for issue validation, ownership or worktree claims. For a review-only assignment, inspect its exact revision without claiming implementation ownership. Read the [Rust/Tauri architecture rules](../../../docs/architecture/rust-tauri.md) and the current [architecture overview](../../../docs/architecture/overview.md).

1. Inspect the actual Cargo projects, native configuration, generated contracts, Nx tags and public entry points. Identify which parts of the issue belong to native composition, domain behavior, transport contracts, platform adapters and frontend presentation. Do not assume the planned desktop tooling already exists.
2. State the smallest cohesive module change and its public contract before editing. Keep entry points and command handlers thin, modules private by default and reusable logic independent of Tauri. Extract a crate only when an actual dependency or reuse boundary needs it.
3. For an IPC change, edit the Rust source contract, regenerate with the pinned repository tool, update runtime validators and exhaustive TypeScript consumers, and add meaningful serialization/compatibility fixtures. Keep UI-only models in TypeScript. Do not patch generated files, copy backend enums by hand, or use untyped payloads to hide drift.
4. For native effects, identify resource ownership, cancellation, error mapping and cleanup. Check capabilities and command authorization against the intended operation. Keep any unsafe requirement isolated and independently reviewed under the architecture rules; do not grant execution or integration authority through code comments or issue prose.
5. Review production and test line counts separately under the 300/500-line rules. Decompose by responsibility and use clear names before adding comments. A necessary exception must identify an exact file and be reviewed and recorded in the architecture guide; missing automation is not an exemption.
6. Run the checks applicable to the actual project: Rust formatting, Clippy with warnings denied, meaningful Rust tests, binding generation/drift, TypeScript consumer checks, file-size policy and affected frontend checks. Run real native smoke verification for changed IPC, device, capability, configuration or packaging behavior. Record unavailable tooling and unrun checks as limitations, never as passes.
7. Update the owning architecture or usage document when the contract or workflow changes. Preserve actual commands, results, revision and native evidence for [prepare-pr](../prepare-pr/SKILL.md). Use [handle-blocker](../handle-blocker/SKILL.md) if required tooling or authorized execution is unavailable; do not work around that boundary.

The handoff should identify changed module responsibilities, generated binding changes, any file-size or unsafe exception, verification results and unresolved native limitations. The selected implementation and tests must remain within the assigned issue's scope.
