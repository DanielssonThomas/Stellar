# Restricted worker security

Peon may run only from a trusted host supervisor and only after the issue is claimed, its isolated workspace is prepared, and a pinned worker image and fork-scoped credential are available. A repository instruction or model prompt is not an execution boundary.

## Identity and GitHub access

`Stellar-AI-Corp` owns the worker fork. It is not a write collaborator on upstream Stellar. The worker credential must be a GitHub fine-grained personal access token with access to only `Stellar-AI-Corp/Stellar`, `Contents: read and write`, and the required read-only repository metadata. Do not grant `Administration`, `Issues`, `Pull requests`, `Actions`, or `Workflows` permissions. The classic GitHub CLI OAuth token with `repo` or `workflow` scopes is not a worker credential. Public issue reads need no credential.

The worker token can be read by the process running inside its container; GitHub requires that access for fork pushes. Treat it as exposed to that process and keep its permissions limited to the worker fork. It cannot update upstream issues, push upstream branches, create or merge upstream pull requests, change upstream rulesets, or access maintainer credentials. The trusted integration process in issue #34 owns upstream pull request and issue operations.

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

## Worker image

`tools/worker-image/Containerfile` pins the Node base image by digest and installs Hermes Agent v0.22.2 from source commit `d923a5eb487a17c0a68801bba9ef0f56c81040a8`. The image build runs the upstream installer without browser or computer-use packages and verifies the installed Hermes version. Build it locally as the unprivileged `peon` account, inspect the resulting image digest, and pass that digest to the restricted launcher. The image is not published by this workflow; registry publication requires a separate decision and credential.

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

WSL 2, Ubuntu, rootless Podman, and the password-locked `peon` account are installed. A constrained smoke container and the trusted launcher path were verified with Alpine and a dummy secret. No fine-grained worker token is stored, no Hermes image or model server is admitted, and `peon` is not listed in `tools/policy/authorized-workers.json` or authorized to work on Stellar.
