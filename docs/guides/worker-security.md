# Restricted worker security

Peon may run only from a trusted host supervisor and only after the issue is claimed, its isolated workspace is prepared, and a pinned worker image and fork-scoped credential are available. A repository instruction or model prompt is not an execution boundary.

## Identity and GitHub access

`Stellar-AI-Corp` owns the worker fork. It is not a write collaborator on upstream Stellar. The worker credential must be a GitHub fine-grained personal access token with access to only `Stellar-AI-Corp/Stellar`, `Contents: read and write`, and the required read-only repository metadata. Do not grant `Administration`, `Issues`, `Pull requests`, `Actions`, or `Workflows` permissions. The classic GitHub CLI OAuth token with `repo` or `workflow` scopes is not a worker credential. Public issue reads need no credential.

The worker token can be read by the process running inside its container; GitHub requires that access for fork pushes. Treat it as exposed to that process and keep its permissions limited to the worker fork. The image uses a read-only Git askpass helper that supplies `GH_TOKEN` only when HTTPS Git requests a password; it does not place the token in a remote URL or command arguments. The token cannot update upstream issues, push upstream branches, create or merge upstream pull requests, change upstream rulesets, or access maintainer credentials. The trusted integration process in issue #34 owns upstream pull request and issue operations.

Create the fine-grained token while signed in as `Stellar-AI-Corp`, selecting only the `Stellar` fork and the permissions above. Enter it directly into the rootless Podman secret store from an interactive Ubuntu shell; do not place it in source control, command arguments, or shell history:

```bash
read -r -s -p 'Fork-only GitHub token: ' token
printf '\n'
printf '%s' "$token" | podman secret create stellar-worker-github-token -
unset token
```

The runner exposes this secret only as `GH_TOKEN` inside the container. It does not inherit host environment variables or proxy settings.

## Execution boundary

The local setup uses WSL 2, Ubuntu, and rootless Podman. The Linux `peon` account has no sudo membership and its password login is locked. `tools/policy/run-restricted-worker.mjs` launches Podman as that account and fails closed unless all of these checks pass:

- The issue number selects the fixed `/home/peon/workspaces/issue-<number>` path. The directory must be owned by `peon`, be a standalone Git checkout, keep its Git metadata inside that checkout, and use a branch beginning with `issue/<number>-`.
- The worker image is pinned by SHA-256 digest and already present in `peon`'s local image store.
- Podman uses a rootless user namespace, the `peon` UID/GID, only the internal `stellar-peon-worker` bridge, and no forwarded ports. A separate trusted proxy sidecar is the only member of both the worker and model networks and the only Peon path to allowlisted GitHub egress.
- The container has a read-only root filesystem and temporary `/tmp`. The issue checkout is writable for assigned work, while every path protected by `.github/CODEOWNERS` from the current `origin/develop` is separately bind-mounted read-only over it. Before launch, the host runner verifies that `origin` is Stellar upstream, local `origin/develop` matches the live branch SHA, and protected mount sources do not resolve through symlinks. The container has no Linux capabilities, `no-new-privileges`, and fixed PID, memory, and CPU limits.
- The runner does not mount Windows drives, the maintainer home, the Podman socket, or the supervisor's Git metadata. It does not use host networking or host environment forwarding.

The rootless user namespace and absent mounts were verified in the local WSL environment. The default supervisor also bounds attempts, runtime, tools, and model tokens; see [agent supervision](agent-supervision.md).

## Private WSL inference service

The local Peon model service runs separately from the worker in rootless Podman. NVIDIA Container Toolkit CDI was generated in Ubuntu WSL from the WSL-provided NVIDIA driver, and a CUDA sample completed on the RTX 4070 SUPER. The service uses the pinned `ghcr.io/ggml-org/llama.cpp` image digest `sha256:c65f01343624f55848a82a6b653880e53399377a92b371975eb3303c1d5647e7` and the Qwen3.5-4B Q4_K_M GGUF copied onto WSL's Linux filesystem. The model file is mounted read-only; its SHA-256 is `00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4`.

The service runs as UID/GID 1001 with all capabilities dropped, `no-new-privileges`, 8 GiB RAM, 6 CPUs, 128 PIDs, one inference slot, a 65,536-token context, 12 GPU layers, batch 128, micro-batch 32, and Q8 KV caches. Its root filesystem remains writable because the WSL CDI hook failed when the service root filesystem was read-only. This does not grant Peon access to the service container: the worker has no Podman socket, container namespace, model mount, or service configuration mount. Keep the service's arguments and model path in the trusted host-side start procedure.

The metered topology uses three existing/dedicated rootless Podman bridges. Qwen remains attached only to `stellar-peon-model` (`internal=true`, DNS-enabled, no host port publication). Peon attaches only to `stellar-peon-worker` (`internal=true`); it has neither a route to the model network nor direct external egress. The trusted, credential-free metering proxy attaches to the worker, model, and egress bridges. It routes model requests to Qwen, and its HTTPS CONNECT relay allows only the configured GitHub hostnames on port 443. Peon uses that relay for fork Git operations. No Windows firewall, WSL-wide networking, Docker, Hermes gateway, unrelated model server, or Windows model server setting is changed. The Windows server remains on `127.0.0.1:18434`; Qwen remains unpublished on port 18435.

The proxy uses Qwen's `/apply-template` and `/tokenize` endpoints to count the fully rendered prompt before forwarding a request. It clamps `max_tokens` to the lesser of the request's limit and the remaining cumulative supervisor budget. It requests completion usage for streaming responses, buffers the completed stream, counts all returned tool calls, and releases it to Hermes only when the tool-call budget remains valid. This makes the result count a pre-execution gate; Hermes has not yet executed those returned tool calls. Upstream failures and cancellations consume the prompt plus the reserved generation budget, so retries cannot refund spent allowance. The proxy's usage endpoint binds only to its own loopback interface. The trusted runner reads it through `podman exec`; the restricted worker cannot query or alter that endpoint. The deterministic supervisor polls these monotonic counters and stops the worker if a budget is exhausted or metering fails.

Hermes Agent v0.22.2 is pinned to source commit `d923a5eb487a17c0a68801bba9ef0f56c81040a8`. Its source invokes `pre_tool_call` once at the normal tool dispatch guard and its hook dispatcher turns callback errors/timeouts into blocking directives, but `model_tools._pre_dispatch_guards` catches exceptions from the dispatcher and proceeds. That outer fail-open catch means the extension hook alone is not a hard control. The metering proxy therefore accounts model-emitted tool calls before returning them to Hermes instead of relying on that hook. The installed v0.22.2 CLI reads `agent.max_turns` (default 500) for tool-calling iterations, and `hermes chat` supports `--max-turns` and `--run-budget`. Peon's read-only config sets `agent.max_turns: 250`; the trusted launcher uses the supported non-interactive `hermes chat` path and mirrors the supervisor's per-attempt runtime budget. The metering proxy's token/tool-call limits and the deterministic supervisor remain the hard worker-wide controls.

The previous direct model-network test and inference smoke came from the earlier topology and are historical evidence only. The new internal worker network was probed from a worker-shaped rootless container: `peon-model` did not resolve (`ENOTFOUND`) and direct access to `1.1.1.1` failed (`ENETUNREACH`). A credential-free metering proxy probe successfully passed a streaming request to the running Qwen service, returned an SSE completion ending in `[DONE]`, and recorded 29 prompt-plus-generated tokens. The existing Qwen command, 65,536-token context, 12 GPU layers, model file, and Windows inference server were unchanged. This probe does not benchmark full-context throughput or admit Peon.

The trusted host operator can start the model service after creating the internal network and copying the verified model to `/home/peon/.local/share/stellar-peon-model/Qwen3.5-4B-Q4_K_M.gguf` with file mode `0444` and parent directory mode `0555`:

```bash
podman network create --internal stellar-peon-model
podman network create --internal stellar-peon-worker
podman network create stellar-peon-egress
podman run -d --name stellar-peon-qwen --pull=never \
  --userns=keep-id --user=1001:1001 \
  --network=stellar-peon-model:alias=peon-model \
  --device=nvidia.com/gpu=all --security-opt=label=disable \
  --cap-drop=all --security-opt=no-new-privileges \
  --pids-limit=128 --memory=8g --memory-swap=8g --cpus=6 \
  --tmpfs=/tmp:rw,nosuid,nodev,noexec,size=1g \
  --mount=type=bind,src=/home/peon/.local/share/stellar-peon-model/Qwen3.5-4B-Q4_K_M.gguf,dst=/models/Qwen3.5-4B-Q4_K_M.gguf,ro \
  ghcr.io/ggml-org/llama.cpp@sha256:c65f01343624f55848a82a6b653880e53399377a92b371975eb3303c1d5647e7 \
  --model /models/Qwen3.5-4B-Q4_K_M.gguf --alias Qwen3.5-4B-Q4_K_M \
  --ctx-size 65536 --n-gpu-layers 12 --parallel 1 \
  --batch-size 128 --ubatch-size 32 --flash-attn on \
  --cache-type-k q8_0 --cache-type-v q8_0 --jinja \
  --host 0.0.0.0 --port 18435
```

Do not add `-p`/`--publish`. Verify Qwen health from the trusted metering proxy and send a small completion through the proxy; Peon cannot access `peon-model` directly. Stop and remove the service with `podman stop stellar-peon-qwen` and `podman rm stellar-peon-qwen`; remove the model, worker, and egress networks only after proxy/worker containers exit with `podman network rm stellar-peon-model stellar-peon-worker stellar-peon-egress`. Remove only the WSL model copy when no longer needed. To roll back CDI, first stop GPU containers, then remove `/etc/cdi/nvidia.yaml`, the `nvidia-container-toolkit.list` source and its keyring, and uninstall `nvidia-container-toolkit-base` if no other WSL workload uses it. These commands do not remove the Windows NVIDIA driver or touch the Windows inference server.

## Worker image

`tools/worker-image/Containerfile` pins the Node base image by digest and installs Hermes Agent v0.22.2 from source commit `d923a5eb487a17c0a68801bba9ef0f56c81040a8`. The image build runs the upstream installer without browser or computer-use packages, runs the pinned package manager's `hermes pm repair` while the install is writable, and executes `verify-hermes-runtime.py`. That check validates the committed venv and selected PM generation, activates dependencies through Hermes' own PM code, and imports core CLI modules without making a model request. The build then runs a non-inference Hermes command while the source tree remains writable, completing pending launcher work before the image is sealed. At runtime, `HERMES_HOME=/tmp/.hermes` holds writable user state while `HERMES_RUNTIME_DIR=/opt/hermes/tools` keeps Hermes' PM pointed at the immutable committed tool store; the paths serve different purposes and must remain explicit. The image redirects Hermes' install, PM preparation, and all relevant environment and generation leases into `/tmp`. Bundled skill content is linked individually from the immutable image so Hermes can create its mutable skill-hub state in the writable home. The credential-free offline startup smoke uses the actual entrypoint and read-only root filesystem. Issue #61's local build digest was `sha256:0da29a84e3dde294f41513eb9a9cfae305e99bd8e412457242a5c138249d294a`; the published GHCR image is pinned in the trusted Peon supervisor as `ghcr.io/stellar-ai-corp/hermes-worker@sha256:faf69a7713ae098bce64c75f3d38d6351c38f9733ea98c5b70bfb17f33381d44`. Podman's pulled image metadata records that GHCR digest and the same image config ID as the local build.

The lockfile-pinned pnpm 10.28.2 bundle is baked into the image-owned `/opt/corepack` cache. The worker and trusted verifier set `COREPACK_HOME=/opt/corepack`, disable Corepack network access and latest-version lookup, and use the same immutable image with read-only root filesystems. They also set `NX_SKIP_NATIVE_FILE_CACHE=true`: Nx otherwise copies its native binding into the `noexec` `/tmp` mount and cannot load it. Keep project dependencies preinstalled in the isolated WSL issue workspace; neither Peon nor verification containers should need package-registry access.

Run the trusted launcher from the Windows repository checkout with a locally approved image digest and the issue's already prepared isolated checkout. The runner starts a credential-free proxy sidecar, waits for its model health check, and then starts Peon on the worker-only internal network:

```powershell
node tools/policy/run-restricted-worker.mjs --issue 123 --image ghcr.io/stellar-ai-corp/hermes-worker@sha256:faf69a7713ae098bce64c75f3d38d6351c38f9733ea98c5b70bfb17f33381d44 -- hermes --issue 123
```

The example is intentionally not ready to launch Peon until the image and scoped token have been admitted. The runner rejects mutable image tags and refuses to create or repair workspaces. A trusted supervisor prepares the checkout and keeps its issue claim separate from the container.

## Admission, removal, and limits

Before admission, the maintainer verifies the fork branch, GitHub permissions, image digest, rootless account, issue claim, and workspace branch. A worker profile is added to `tools/policy/authorized-workers.json` only through a reviewed maintainer change. The trusted supervisor assigns a single issue and invokes the runner; worker code cannot access the Podman CLI or socket from inside the container. Protected governance changes remain ineligible under the [worker integration policy](worker-integration-policy.md).

To remove Peon, stop its active container, revoke its fine-grained token in GitHub, remove the Podman secret with `podman secret rm stellar-worker-github-token`, remove its worker authorization and issue assignment through the trusted workflow, and preserve its workspace for review or reassignment. Rotate the token immediately if it may have been exposed.

This boundary contains ordinary model-issued commands and accidental access. A rootless container still shares the WSL Linux kernel, and a worker process can intentionally send its fork-scoped token or workspace contents to the public network. Do not mount private host data or broader credentials, do not use privileged containers, and do not treat this setup as protection against a kernel or container-runtime vulnerability.

## Current admission state

WSL 2, Ubuntu, rootless Podman, and the password-locked `peon` account are installed. Issue #21/PR #36 and issue #43/PR #44 are complete. The trusted metering proxy and internal worker-only network prevent direct model and internet access; actual Qwen inference, usage accounting, request failure, streaming, cancellation, and network-denial probes passed. The deterministic supervisor polls trusted sidecar counters and stops on exhaustion or accounting failure. The `peon` profile and trusted fork mapping in this PR admit exactly the first bounded trial tracked by issue #24; Peon has no upstream write, integration, administrator, merge, or container-runtime access. Admission does not establish autonomous readiness; the coding trial and its issue-linked PR must pass review before further work is assigned.
