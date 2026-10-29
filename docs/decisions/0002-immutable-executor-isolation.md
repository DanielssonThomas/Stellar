# ADR 0002: Isolate immutable corrections in a disposable Linux VM

**Status:** Proposed for issue #140. No executor is provisioned and correction dispatch remains denied.

## Context

Peon can create a file in the authoritative Windows checkout through `/mnt/d` from the current Ubuntu WSL distribution. A Linux UID in that distribution therefore cannot enforce the required host access denial. Issue #140 needs a separately enforced execution boundary before correction dispatch can be considered.

## Decision

Use one disposable Linux VM per correction attempt, with a private copy-on-write disk, rootless Podman, no shared folders, no host drive mounts, no guest network adapter, and no GPU. The trusted host broker sends a digest-bound source package and receives bounded output over a dedicated QEMU virtio-serial channel. It also relays only metered model requests to the existing Qwen service. The host remains the authority for source sealing, attempt authorization, lifecycle, candidate validation, and publication denial. Do not start a VM until the host plan and negative tests are approved.

The host currently runs Windows 11 Home (build 26200) with about 32 GiB RAM, WSL 3.0.3, Ubuntu WSL2, Podman 5.7.0, and an RTX 4070 Super. Full client Hyper-V is unavailable on Home. QEMU with Windows Hypervisor Platform acceleration is a candidate, subject to confirming the optional feature and testing it without disabling WSL or host security features. Qwen remains in the existing WSL environment and keeps the GPU; the correction VM needs CPU and memory only.

## Alternatives

| Design                                                        | Isolation claim                                                                                                                                                                                         | Cost and remaining problem                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Separate WSL distribution with automount and interop disabled | Removes convenient drive and Windows executable paths. It does not create a security sandbox: WSL users can control their instances, and a distribution's root can change its settings or mount drives. | Low memory and familiar Podman, but cannot prove denial of Windows checkout access under the current Windows principal. Do not admit corrections with this alone.                                                                                                                                                                                                                       |
| Separate Windows principal running WSL                        | Windows ACLs can deny that principal direct access to Windows files, even if it is Linux root.                                                                                                          | Potentially lower VM overhead, but current checkout inherits `Authenticated Users` Modify. Every trusted ancestor, checkout, credential store, WSL distribution, snapshot, and IPC endpoint needs an ACL inventory and negative tests. WSL distribution access and Linux-root behavior remain in scope. This is a viable fallback only after a complete principal/ACL design and proof. |
| Per-attempt Linux VM                                          | The hypervisor and QEMU device model separate guest memory, kernel, disk, and devices from the host. No host filesystem or general network is presented.                                                | Requires an approved VM runtime and golden image; approximately 6 GiB guest RAM, 2 vCPUs, a 20 GiB base disk, and a small per-attempt overlay. Boot, pinned-image distribution, serial protocol, and restart recovery need tests.                                                                                                                                                       |

The VM is the smallest design with a clear enforced boundary for this threat model on the current host. It avoids broad Windows ACL changes and does not duplicate the model or pass through the GPU. The QEMU process, hypervisor, serial broker, and guest bootstrap are trusted components; a VM escape or broker vulnerability remains a risk.

## Consequences

This direction requires a VM runtime, guest image, broker protocol, and crash recovery work before any production correction. The current inert same-WSL account plan cannot be connected to a launcher. Existing Peon and Qwen operation continues in Ubuntu WSL. No publication authority is added.

## Trusted communication and enforcement

1. The host validates Git authorization, captures source with replacement objects and external Git helpers disabled, seals a root-owned manifest, and journals an attempt ID, exact digest, image digest, limits, and VM disk identity. A failed or incomplete seal is quarantined.
2. The host starts QEMU with a read-only golden disk and one private copy-on-write overlay for this attempt. The VM receives no host directory, drive, clipboard, QMP monitor, guest agent, SSH server, or network adapter. The guest cannot open Peon's store or GitHub credentials because no path or endpoint to them exists. The host broker exposes a dedicated length-prefixed virtio-serial protocol, not a shell or host command service.
3. The broker sends only `Begin(attempt, snapshotDigest, limits)` and bounded source bytes. The trusted guest initializer verifies the manifest and copies source to a named Podman volume. The rootless worker gets a read-only sealed bind, private writable volume, read-only root filesystem, pinned image, and explicit CPU, memory, PID, time, and tool limits. Guest Linux ownership protects the guest seal from the rootless worker; the VM boundary protects the host seal even if the guest is compromised.
4. Model requests traverse the same broker in a separate framed message type. The host meter validates attempt identity, counts requests/tokens before forwarding to the existing model, and refuses all other destinations. Usage reported by the worker is diagnostic only. The host broker reports its own counters and records QEMU PID, process start identity, disk identity, and heartbeat deadlines.
5. The guest streams bounded candidate file records, with path, type, mode, size, and hash, over the channel. The host treats all bytes as untrusted, rejects links, special files, duplicate or escaping paths, protected-path or scope changes, and size overruns, then builds and verifies a new host-owned candidate against the exact baseline digest. A disposable verifier receives only that candidate digest and its own writable overlay. Verification never writes the candidate.
6. The host cancels by closing the meter and stopping the exact QEMU process. Termination is confirmed by host process inspection, not by a guest message. On timeout, crash, pipe loss, uncertain termination, or incomplete journal/snapshot/overlay rename, quarantine the attempt and preserve its disk and bounded evidence. Never resume the worker automatically, reuse its ID, or clean another attempt. Recovery first proves the old VM is stopped, revalidates journal and hashes, then either collects under the same strict rules or discards the attempt with operator authorization.

Canonical Git refs, checkout synchronization, remote push, issue revalidation, and correction dispatch are outside this proposal and remain disabled. No guest message can authorize publication.

## Provisioning and rollback gates

Approval is required to install QEMU, enable Windows Hypervisor Platform if absent, create the golden Linux VM image and its rootless Podman executor, add the host serial broker, and reserve disk/RAM. Do not enable full Hyper-V by changing Windows edition or disable WSL, memory integrity, or other host security features as a workaround. Record exact installer/version hashes and image digest before use.

After approval, provision a minimal Linux guest with no SSH credentials, no sudo for the executor, dedicated UID/GID and subordinate ranges, rootless Podman on guest ext4, and the pinned worker image imported by digest into the golden image. Seal the golden image read-only. For each attempt, create a uniquely named copy-on-write overlay, boot at most one VM, and retain the overlay until collection or quarantine is resolved. Rollback stops and verifies the exact VM, disables the broker endpoint, quarantines overlays and journals, then removes the VM image/runtime only after evidence preservation. Existing Ubuntu WSL, Peon storage, model service, and historical handoffs stay untouched.

## Required validation

- Confirm QEMU WHPX works concurrently with the existing WSL/Qwen workload and Podman enforces resource limits in the guest. Measure peak host memory and reject the design if Windows, WSL, and the 6 GiB guest cannot coexist without pressure.
- From arbitrary guest root and the rootless worker, attempt to read and write the authoritative `/mnt/d` checkout, canonical refs, Windows credentials, Peon's Podman store, host snapshots and candidates, and a prior attempt overlay. All must fail because the resources are absent from guest devices and communication, not because a path happens to be unmounted.
- Fuzz the serial framing with oversized lengths, replayed/wrong attempt IDs, duplicate paths, malicious file types, forged usage, late output, and abrupt disconnects. Confirm no host command execution or unauthorized model endpoint is reachable.
- Kill the guest worker, guest OS, broker, and QEMU at each lifecycle step, then reboot the host. Prove exact-process termination, journal quarantine, durable output bounds, no cross-attempt cleanup, and no automatic replay.
- Confirm the golden image and every overlay contain no GitHub credential, Windows drive, host socket, QMP monitor, or model key. Verify candidate digest before and after disposable verification, and prove canonical refs remain unchanged.

## Related references

- [Agent supervision](../guides/agent-supervision.md)
- [Microsoft WSL configuration](https://learn.microsoft.com/en-us/windows/wsl/wsl-config)
- [Microsoft WSL enterprise security](https://learn.microsoft.com/en-us/windows/wsl/enterprise/)
- [Microsoft Hyper-V availability](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/get-started/install-hyper-v?pivots=windows)
- [QEMU WHPX](https://www.qemu.org/docs/master/system/whpx.html)
- [QEMU network and character devices](https://www.qemu.org/docs/master/system/qemu-manpage.html)
- [Podman rootless mode](https://docs.podman.io/en/latest/markdown/podman.1.html)
