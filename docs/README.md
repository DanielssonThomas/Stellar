# Documentation

- [Architecture overview](architecture/overview.md): current workspace structure, dependency direction, and governance boundaries.
- [Rust and Tauri boundaries](architecture/rust-tauri.md): modular native code, generated TypeScript contracts, readability and verification requirements; links to the Rust/Tauri workflow skill.
- [Documentation policy](documentation-policy.md): ownership and maintenance rules for technical documentation.
- [Architecture decisions](decisions/0001-nx-angular-library-architecture.md): why the initial framework and library boundaries were chosen.
- [Independent integration approval proposal](decisions/0002-independent-integration-approval.md): proposed separation of technical assessment, management recommendation and human authorization; not an active merge route.
- [Manual release guide](guides/manual-release.md): maintainer-controlled monthly release procedure.
- [Nx generators](guides/generators.md): application, atomic component, and service generator commands and defaults.
- [Issue workflow](guides/issue-workflow.md): metadata, ownership, dependencies, and status transitions.
- [AI review priority](guides/ai-review-policy.md): review tiers, trusted file risk, offline dispatch limits, and future enforcement.
- [Agent issue worktrees](guides/agent-worktrees.md): claim, resume, transfer, and preserve issue-specific worktrees.
- [Agent supervision](guides/agent-supervision.md): bounded worker attempts, durable handoffs, verification, and escalation requests.
- [Worker integration policy](guides/worker-integration-policy.md): deterministic offline eligibility checks for restricted worker pull requests.
- [Restricted worker security](guides/worker-security.md): fork-only identity, local WSL and Podman boundaries, admission, and removal.
- [Engineering organization](guides/engineering-organization.md): Architect, Foreman, Peon roles, profile setup, authority, and offline workflow.
- [Stellar Live telemetry](guides/live-telemetry.md): local read-only source map, launch, and observation limits.
- [Local operations dashboard](guides/operations-dashboard.md): launch, read-only status sources, and current Character Studio data limits.
- [Development roadmap](implementation/roadmap.md): bootstrap status and links to GitHub work.

Operational guides will be added with the workflows they describe.
