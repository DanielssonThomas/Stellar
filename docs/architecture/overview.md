# Architecture overview

## Current workspace

Stellar is an Nx integrated monorepo using Angular 21.2, TypeScript, and pnpm. `apps/stellar-web` is the application shell. `apps/stellar-web-e2e` is its Playwright project. The shell owns bootstrap, routes, and composition; shared UI belongs in `libs/`.

The first UI library is `libs/ui/atoms`. Its components demonstrate conventional atomic-layer naming, Tailwind styling through `libs/design-tokens`, and a reusable skeleton loading primitive. The app imports the component library through its public entry point and the token stylesheet through its global styles.

The application shell now composes a local operations dashboard and Character Studio. A loopback-only Node adapter under `tools/dashboard/` exposes a single read-only status route using fixed Hermes profile IDs and selected session database columns; the app also shows public GitHub issue and PR metadata. The character panels have explicit empty states until an approved character source is linked. See the [local dashboard guide](../guides/operations-dashboard.md) for launch and data boundaries.

## Dependency direction

Nx project tags and `@nx/enforce-module-boundaries` in `eslint.config.mjs` govern imports. Applications may import shared libraries. Shared libraries may import other shared libraries. UI layer tags constrain dependencies upward from atoms to molecules, organisms, and templates. Cycles and imports that violate these constraints fail linting.

Repository-owned Nx generators scaffold Angular applications and their mirrored Playwright E2E projects, atomic components, and shared Angular services. Their maintained invocation guide is [Generators](../guides/generators.md). Buildable Angular libraries use the Angular unit-test builder with Vitest; non-buildable Angular libraries use Nx's Vitest Analog integration.

## Verification

Angular's supported unit-test builder runs Vitest. App tests share an MSW server setup for HTTP mocks. Playwright verifies the app's user-visible composition. Nx supplies project-aware targets and affected execution.

## Governance

GitHub Issues are the canonical work source. The repository contains an issue template, a validator, and an operational `create-issue` skill. A GitHub Actions workflow validates issue changes and returns invalid work to triage. The local issue worktree manager checks current metadata and native dependencies, then coordinates claims in the shared Git common directory. See the [issue workflow](../guides/issue-workflow.md) for metadata and the [agent worktree guide](../guides/agent-worktrees.md) for its local coordination limits.

Protected infrastructure includes `.husky/`, `.github/workflows/`, `.agents/skills/`, `AGENTS.md`, lint and Nx policy, generators, policy scripts, and `docs/documentation-policy.md`; `.github/CODEOWNERS` identifies the protected paths. The public repository has active ruleset 25456574 for `main`, `develop`, and `release/**`: changes require a pull request and the `verify` CI check; deletion and force pushes are blocked. `main` is the default production branch. The ruleset requires zero approving reviews and no CODEOWNERS approval, and has no bypass actors. These settings are verified, but they do not provide a second-person review.

Codex may act as temporary bootstrap maintainer during Epic 2, including merging its own PRs after the required checks pass and the issue scope is met. This bootstrap permission is not granted to Hermes. Hermes remains unauthorized until its separate identity, least-privilege access, protected-resource controls, bounded supervision, and controlled trial are verified. Hermes workers may not merge or modify protected governance resources. Production deployment and promotion of `main` need separate authorization; neither is authorized by the bootstrap permission.

The monthly release process is documented but is manual. No Vercel account, production environment, deployment, or release branch is configured yet. See the [manual release guide](../guides/manual-release.md) for current prerequisites and restrictions.
