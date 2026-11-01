# Desktop development

`apps/stellar-desktop` is the separate Angular shell; `apps/stellar-desktop-e2e` is its mirrored Chromium project. Both came from the governed application generator. The existing web application and operations dashboard remain separate. The desktop currently contains only a title and router outlet. Microphone capture, installers, signing, updates and autostart are outside this bootstrap.

## Windows setup and launch

Install Node 22, Corepack/pnpm, Rustup, Visual Studio Build Tools with the C++ desktop workload and Windows SDK, and the Microsoft Edge WebView2 Runtime. Run `pnpm install --frozen-lockfile` at the workspace root. `rustup show` installs the repository's pinned Rust 1.99.1 toolchain with rustfmt and Clippy. `Cargo.lock` pins native dependencies; Tauri 2.12.5, tauri-build 2.7.4 and ts-rs 12.0.1 are explicitly pinned in manifests.

```sh
pnpm exec nx run stellar-desktop:native-launch
```

This builds Angular, compiles the embedded-content host, and opens `target/debug/stellar-desktop.exe`. Native decorations retain Windows close, minimize, drag, resize, system menu and keyboard behavior. The minimum window size is 480 × 360. Close the window to end the process. The browser-only development server is `pnpm exec nx serve stellar-desktop` at `http://127.0.0.1:4300`; it does not provide native IPC.

The composition root registers thin commands; private `shell` behavior has no Tauri dependency. No background tasks or device resources exist yet. The local main capability grants only the read-only `shell_status` command, enrolled through `AppManifest::commands`. Production configuration has an explicit CSP, no remote capability, no filesystem or shell plugin and no developer tools. Navigation permits only the embedded local origin. Native commands validate deserialized requests and version compatibility.

## Contracts and checks

Rust owns IPC serialization. `libs/desktop-contracts` exports ts-rs output and a strict reply decoder; future frontend adapters should use that public entry point. Change Rust first, run `node tools/native/cargo.mjs contract-generate`, and review the generated diff. `contract-check` fails on drift, including uncommitted changes to generated output.

```sh
pnpm exec nx run-many -t lint test build --projects=stellar-desktop,desktop-contracts
pnpm exec nx run stellar-desktop-e2e:e2e
pnpm exec nx run-many -t native-fmt native-clippy native-test contract-check rust-size-check native-smoke --projects=stellar-desktop --parallel=1
```

Native targets declare Cargo manifests, lockfile, toolchain, Rust/configuration, scripts, generated consumer and architecture policy inputs. Build and smoke additionally depend on the Angular build and its production dependencies. Cargo build outputs live under ignored `target/`; interactive launch and native smoke are uncached. Smoke compiles into a separate `target/smoke/` directory so its additional feature cannot replace the normal host artifact.

`native-smoke` opens a real embedded WebView, waits for the Angular title, invokes the version-one readiness command, verifies its reply and checks rejection of an unsupported version. A compile-time `native-smoke` feature supplies a completion command and a capability overlay only for that test build. It is absent from the normal host command registration. The parent fails after 30 seconds if the WebView does not complete and writes successful results to `artifacts/native/smoke.json`. This is native WebView/IPC evidence, not microphone or installer verification.

The Rust size gate uses syn syntax trees to separate complete exact `cfg(test)` items; strings, braces and comments cannot masquerade as test attributes. Ambiguous conditions count as production. Dedicated test files are counted wholly as tests. Git enumerates tracked and new nonignored Rust sources; no tracked source has an exclusion. Cargo build products and dependency installations are not repository source. Both production and test counts flag decomposition review at 300 physical lines and fail above 500 unless the exact path/category has a reviewed, unexpired registry entry in the [Rust/Tauri architecture rules](../architecture/rust-tauri.md). Registry validation rejects unknown exclusion fields, wildcards, duplicates, missing paths, missing rationale/alternatives/authorization, expired reassessment dates and exceeded ceilings. No exception is approved.

## Continuous integration

Ubuntu quality checks discover every affected project with an E2E target before installing Chromium dependencies. A Windows native job always runs pinned native checks and actual WebView smoke; this favors a clear required gate over a conditional skip route. Cargo and Nx caches reduce repeat work. Required `verify` requires explicit success from both jobs; failed, cancelled, skipped or missing native results cannot turn green.
