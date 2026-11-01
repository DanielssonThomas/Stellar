# Desktop development

`apps/stellar-desktop` is the separate Angular shell; `apps/stellar-desktop-e2e` is its mirrored Chromium project. Both came from the governed application generator. The existing web application and operations dashboard remain separate. The desktop contains a title and router outlet; its composition initializes the shared typed app-info adapter and observes its native snapshot event. Microphone capture, installers, signing, updates and autostart are outside this bootstrap.

## Windows setup and launch

Install Node 22, Corepack/pnpm, Rustup, Visual Studio Build Tools with the C++ desktop workload and Windows SDK, and the Microsoft Edge WebView2 Runtime. Run `pnpm install --frozen-lockfile` at the workspace root. `rustup show` installs the repository's pinned Rust 1.99.1 toolchain with rustfmt and Clippy. `Cargo.lock` pins native dependencies; Tauri 2.12.5, tauri-build 2.7.4 and ts-rs 12.0.1 are explicitly pinned in manifests.

```sh
pnpm exec nx run stellar-desktop:native-launch
```

This builds Angular, compiles the embedded-content host, and opens `target/debug/stellar-desktop.exe`. Native decorations retain Windows close, minimize, drag, resize, system menu and keyboard behavior. The minimum window size is 480 × 360. Close the window to end the process. The browser-only development server is `pnpm exec nx serve stellar-desktop` at `http://127.0.0.1:4300`; it does not provide native IPC.

The composition root registers thin commands; private `shell` behavior has no Tauri dependency. No background tasks or device resources exist yet. The local main capability grants only the read-only `shell_status` and `app_info` commands, enrolled through `AppManifest::commands`, plus event listen/unlisten. App-info emits one snapshot to the local main window when queried; no background event service or device work is started. Production configuration has an explicit CSP, no remote capability, no filesystem or shell plugin and no developer tools. Navigation permits only the embedded local origin. Native commands validate deserialized requests and version compatibility.

Angular production builds keep critical CSS external (`optimization.styles.inlineCritical: false`) to avoid its inline stylesheet activation handler under the strict script policy. Tauri supplies a fresh nonce on the static color-scheme style anchor in each embedded response. Bootstrap passes that runtime value through Angular's `CSP_NONCE` token so component styles receive the same authorized nonce; browser development without native CSP uses no nonce. The native smoke checks actual component and utility computed styles, centering, viewport height and nonce propagation. See [Angular's CSP guidance](https://angular.dev/best-practices/security#content-security-policy).

## Contracts and checks

Rust owns IPC serialization. `libs/desktop-contracts` is tagged scope:shared/type:model and exports ts-rs output, generated command/event maps and strict runtime decoders. The governed scope:shared/type:util service-desktop-adapter owns native calls, sanitizes errors and disposes subscriptions, including late registrations. Its browser fake advertises no native capabilities. Change Rust first, run `node tools/native/cargo.mjs contract-generate`, and review the generated diff. `contract-check` fails on drift, including uncommitted changes to generated output.

```sh
pnpm exec nx run-many -t lint test build --projects=stellar-desktop,desktop-contracts
pnpm exec nx run stellar-desktop-e2e:e2e
pnpm exec nx run-many -t native-fmt native-clippy native-test contract-check rust-size-check native-smoke --projects=stellar-desktop --parallel=1
```

Native targets declare Cargo manifests, lockfile, toolchain, Rust/configuration, scripts, generated consumer and architecture policy inputs. Build and smoke additionally depend on the Angular build and its production dependencies. Cargo build outputs live under ignored `target/`; interactive launch and native smoke are uncached. Smoke compiles into a separate `target/smoke/` directory so its additional feature cannot replace the normal host artifact.

`native-smoke` opens a real embedded WebView, waits for the Angular title, invokes the version-one readiness command, verifies its reply and checks rejection of an unsupported version. A compile-time `native-smoke` feature supplies a completion command and a capability overlay only for that test build. It is absent from the normal host command registration. The parent fails after 30 seconds if the WebView does not complete and writes successful results to `artifacts/native/smoke.json`. This is native WebView/IPC evidence, not microphone or installer verification.

The Rust size gate uses syn syntax trees to separate complete exact `cfg(test)` items; strings, braces and comments cannot masquerade as test attributes. Ambiguous conditions count as production. Dedicated test files are counted wholly as tests. Git enumerates tracked and new nonignored Rust sources; no tracked source has an exclusion. Cargo build products and dependency installations are not repository source. Both production and test counts flag decomposition review at 300 physical lines and fail above 500 unless the exact path/category has a reviewed, unexpired registry entry in the [Rust/Tauri architecture rules](../architecture/rust-tauri.md). Registry validation rejects unknown exclusion fields, wildcards, duplicates, missing paths, missing rationale/alternatives/authorization, expired reassessment dates and exceeded ceilings. No exception is approved.

## Extending app-info contracts

App-info uses version 1, snake_case fields, internally tagged capability/error unions and canonical unsigned u64 decimal sequence strings (0 through 18446744073709551615). Never convert a sequence to a JavaScript number. Optional labels accept omitted/null input and serialize as omitted when absent; labels are bounded to 80 UTF-8 bytes. The required build_revision field is nullable and currently null for an unversioned development build. Replies contain at most two distinct known capabilities and no unbounded internal metadata. Rust and TypeScript consume the same JSON fixtures in libs/desktop-contracts/fixtures/.

1. Change the private Rust app_info wire DTOs/domain and command metadata, keeping Stage/audio presentation state in TypeScript. Add bounded typed errors rather than propagating native messages.
2. Run node tools/native/cargo.mjs contract-generate. Do not hand-edit generated.ts. Update runtime decoders and the exhaustive capability consumer alongside new variants.
3. Run the contract-check target: it generates twice, rejects committed-output drift and enables the Rust contract-variant-fixture feature in the exporter to prove a new Rust enum variant fails the real TypeScript exhaustive consumer. The fixture variant is absent from normal builds and its output is never committed.
4. Run model/adapter/frontend tests plus native fmt, Clippy, serialization fixtures and actual native-smoke. Startup exercises the typed adapter, its event subscription and maximum u64 correlation; native smoke also requires a typed malformed-input rejection.

Type generation does not validate runtime data. Native command adapters deserialize untrusted values to DTOs and map malformed requests to a typed error. Frontend decoders reject unsupported versions, variants, extra fields, malformed/nullability values, duplicate capabilities and excessive strings/arrays. Subscriptions are owned by their adapter: stop individual listeners or dispose it when their owner ends; Angular injector destruction handles the injected service.

## Continuous integration

Ubuntu quality checks discover every affected project with an E2E target before installing Chromium dependencies. A Windows native job always runs pinned native checks and actual WebView smoke; this favors a clear required gate over a conditional skip route. Cargo and Nx caches reduce repeat work. Required `verify` requires explicit success from both jobs; failed, cancelled, skipped or missing native results cannot turn green.
