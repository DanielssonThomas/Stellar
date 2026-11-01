# Windows desktop feasibility probe

This isolated #175 probe tests actual Tauri IPC, generated Rust contracts and opt-in Web Audio. It is not a production application or a qualified autonomous worker run. Foreman supplied the Rust contracts, domain behavior and unit tests; Codex reviewed, corrected and integrated them.

Use Rust 1.99.1 with the MSVC target, Visual Studio C++ build tools, WebView2 and the repository's pinned Node/pnpm dependencies. Cargo.lock fixes the dependency graph. No global toolchain or system PATH changes are required.

From the repository root, with Cargo on the process PATH:

```powershell
node tools/desktop-probe/contracts.mjs
node tools/desktop-probe/contracts.mjs --check
node tools/desktop-probe/build-frontend.mjs
node node_modules/vitest/vitest.mjs run --config tools/desktop-probe/vitest.config.mts
```

From `tools/desktop-probe/src-tauri`:

```powershell
cargo fmt --all -- --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
cargo build --locked --features custom-protocol
```

Launch `target/debug/stellar-desktop-probe.exe`, or the equivalent path beneath a configured `CARGO_TARGET_DIR`. The native window automatically checks a tagged enum, the maximum u64 as a decimal string, an optional field, a typed command error and two native events. No microphone is requested by these checks.

For a localhost development-content comparison, run `node tools/desktop-probe/serve.mjs` in a separate terminal. Set the build process's `TAURI_CONFIG` to `{"build":{"devUrl":"http://127.0.0.1:1425"}}`, then run `cargo build --locked` without `custom-protocol`. Clear that process variable before returning to the embedded-content build. Close the app before rebuilding its executable on Windows.

Microphone capture starts only from **Start microphone**. **Stop & release microphone** disconnects the graph, stops every track and closes the audio context; closing the page also releases tracks. A pending permission result is discarded and its tracks stopped if cancellation already occurred. No recording, upload or model integration exists. RMS ≥ 0.035 is labelled sound activity, never speech detection. Permission denial, no device and device-ending cases have adapter tests; physical permission/device outcomes must be observed separately in the native window.

For diagnosis, the meter uses dBFS and displays RMS, peak, analyser poll count (`frames`), context state/time, sample rate, track state and mute state. Polling can continue while the context is suspended; the counter alone does not prove audio processing. Input labels appear locally; device identifiers are not included in diagnostics or persisted. **List inputs** enumerates devices without starting capture. Labels can remain hidden before permission; stop capture, list again, select an input and press Start to change it. **Resume audio** is available if the context is suspended. Context creation and its initial resume occur directly in the Start gesture. Exact zero samples, a suspended context and a muted track are distinct observations; a quiet level below the activity threshold is not proof that capture failed. The initial user test reported no visible activity; physical capture remains unverified until these diagnostics establish the actual result.

`contracts.rs` owns transport types; `domain.rs` validates and evaluates them without Tauri. `commands.rs` only delegates and emits a bounded event. The frontend adapter decodes unknown runtime payloads and uses Rust-generated types. Large integers travel as strings; `None` is omitted on output. Rust also accepts explicit null for an optional input and normalizes it to omission. ts-rs does not model serde's `deny_unknown_fields`; explicit runtime validators and serialization tests enforce that rule. Generated bindings are formatted by the repository's pinned Prettier and checked without editing the output.

The capability permits one application command and event listen/unlisten only. CSP allows local assets and IPC; no remote executable content, filesystem, shell or microphone plugin is granted. The development server binds loopback only. Native smoke observations and remaining hardware checks belong to the #175 decision record; browser tests alone are not native evidence.
