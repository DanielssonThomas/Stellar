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
- Podman uses a rootless user namespace, the `peon` UID/GID, a private slirp network with host loopback disabled, and no forwarded ports.
- The container has a read-only root filesystem, only the issue checkout mounted read/write, a temporary `/tmp`, no Linux capabilities, `no-new-privileges`, and fixed PID, memory, and CPU limits.
- The runner does not mount Windows drives, the maintainer home, the Podman socket, or the supervisor's Git metadata. It does not use host networking or host environment forwarding.

The rootless user namespace and absent mounts were verified in the local WSL environment. The default supervisor also bounds attempts, runtime, tools, and model tokens; see [agent supervision](agent-supervision.md).

## Private WSL inference service

The local Peon model service runs separately from the worker in rootless Podman. NVIDIA Container Toolkit CDI was generated in Ubuntu WSL from the WSL-provided NVIDIA driver, and a CUDA sample completed on the RTX 4070 SUPER. The service uses the pinned `ghcr.io/ggml-org/llama.cpp` image digest `sha256:c65f01343624f55848a82a6b653880e53399377a92b371975eb3303c1d5647e7` and the Qwen3.5-4B Q4_K_M GGUF copied onto WSL's Linux filesystem. The model file is mounted read-only; its SHA-256 is `00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4`.

The service runs as UID/GID 1001 with all capabilities dropped, `no-new-privileges`, 8 GiB RAM, 6 CPUs, 128 PIDs, one inference slot, a 65,536-token context, 12 GPU layers, batch 128, micro-batch 32, and Q8 KV caches. Its root filesystem remains writable because the WSL CDI hook failed when the service root filesystem was read-only. This does not grant Peon access to the service container: the worker has no Podman socket, container namespace, model mount, or service configuration mount. Keep the service's arguments and model path in the trusted host-side start procedure.

Podman cannot combine rootless `slirp4netns` and a second network. The worker therefore joins a dedicated rootless `stellar-peon-egress` bridge for outbound GitHub access and the separate `stellar-peon-model` network for inference. The model network is `internal=true`, DNS-enabled, and has no host port publication. The model service is attached only to that internal network, and the runner fails closed unless the model network exists and is internal and the egress network exists and is external. A non-member container was unable to resolve or reach `peon-model`; the restricted worker resolved the alias and completed a Qwen response. No Windows firewall, WSL networking, Docker, Hermes gateway, or Windows model server setting was changed. The Windows server remained listening at `127.0.0.1:18434`; no process listened on Windows port 18435.

The trusted host operator can start the model service after creating the internal network and copying the verified model to `/home/peon/.local/share/stellar-peon-model/Qwen3.5-4B-Q4_K_M.gguf` with file mode `0444` and parent directory mode `0555`:

```bash
podman network create --internal stellar-peon-model
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

Do not add `-p`/`--publish`. Verify from Peon's restricted container with `curl http://peon-model:18435/health` and a small `/v1/chat/completions` request. Stop and remove the service with `podman stop stellar-peon-qwen` and `podman rm stellar-peon-qwen`; remove both networks after the worker container exits with `podman network rm stellar-peon-model stellar-peon-egress`. Remove only the WSL model copy when no longer needed. To roll back CDI, first stop GPU containers, then remove `/etc/cdi/nvidia.yaml`, the `nvidia-container-toolkit.list` source and its keyring, and uninstall `nvidia-container-toolkit-base` if no other WSL workload uses it. These commands do not remove the Windows NVIDIA driver or touch the Windows inference server.

## Worker image

`tools/worker-image/Containerfile` pins the Node base image by digest and installs Hermes Agent v0.22.2 from source commit `d923a5eb487a17c0a68801bba9ef0f56c81040a8`. The image build runs the upstream installer without browser or computer-use packages and verifies the installed Hermes version. At runtime, the image keeps installed package files read-only and redirects Hermes' install lock and lease state into `/tmp`; the remaining Hermes home also lives in `/tmp`. Build it locally as the unprivileged `peon` account, inspect the resulting image digest, and pass that digest to the restricted launcher. The image is not published by this workflow; registry publication requires a separate decision and credential.

Run the trusted launcher from the Windows repository checkout with a locally approved image digest and the issue's already prepared isolated checkout:

```powershell
node tools/policy/run-restricted-worker.mjs --issue 123 --image ghcr.io/stellar-ai-corp/hermes-worker@sha256:REPLACE_WITH_64_HEX_DIGEST -- hermes --issue 123
```

The example is intentionally not ready to launch Peon until the image and scoped token have been admitted. The runner rejects mutable image tags and refuses to create or repair workspaces. A trusted supervisor prepares the checkout and keeps its issue claim separate from the container.

## Admission, removal, and limits

Before admission, the maintainer verifies the fork branch, GitHub permissions, image digest, rootless account, issue claim, and workspace branch. A worker profile is added to `tools/policy/authorized-workers.json` only through a reviewed maintainer change. The trusted supervisor assigns a single issue and invokes the runner; worker code cannot access the Podman CLI or socket from inside the container. Protected governance changes remain ineligible under the [worker integration policy](worker-integration-policy.md).

To remove Peon, stop its active container, revoke its fine-grained token in GitHub, remove the Podman secret with `podman secret rm stellar-worker-github-token`, remove its worker authorization and issue assignment through the trusted workflow, and preserve its workspace for review or reassignment. Rotate the token immediately if it may have been exposed.

This boundary contains ordinary model-issued commands and accidental access. A rootless container still shares the WSL Linux kernel, and a worker process can intentionally send its fork-scoped token or workspace contents to the public network. Do not mount private host data or broader credentials, do not use privileged containers, and do not treat this setup as protection against a kernel or container-runtime vulnerability.

## Current admission state

WSL 2, Ubuntu, rootless Podman, and the password-locked `peon` account are installed. The pinned Hermes image is built locally and its version command passes in a read-only container. GPU compute, the private model endpoint, and a Qwen response from a container using the restricted launch limits were verified. Negative checks confirmed a read-only worker root filesystem, no Windows system or model-file mounts, and no Podman or Docker socket; a container outside the internal model network could not reach the endpoint. The model service has no published ports. The fine-grained worker token must be rotated before future Peon launches because a diagnostic shell trace accidentally disclosed it in tool output. This does not admit Peon to autonomous work: `peon` is not listed in `tools/policy/authorized-workers.json`, issue #21 has not completed its review, and no Hermes coding run or issue assignment was started.
