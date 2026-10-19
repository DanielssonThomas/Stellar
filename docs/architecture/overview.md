# Architecture overview

## Current workspace

Stellar is an Nx integrated monorepo using Angular 21.2, TypeScript, and pnpm. `apps/stellar-web` is the application shell. `apps/stellar-web-e2e` is its Playwright project. The shell owns bootstrap, routes, and composition; shared UI belongs in `libs/`.

The first UI library is `libs/ui/atoms`. Its components demonstrate conventional atomic-layer naming, Tailwind styling through `libs/design-tokens`, and a reusable skeleton loading primitive. The app imports the component library through its public entry point and the token stylesheet through its global styles.

## Dependency direction

Nx project tags and `@nx/enforce-module-boundaries` in `eslint.config.mjs` govern imports. Applications may import shared libraries. Shared libraries may import other shared libraries. UI layer tags constrain dependencies upward from atoms to molecules, organisms, and templates. Cycles and imports that violate these constraints fail linting.

Project and component generators are planned work; inspect the installed Nx generators and current tags until repository-owned generators are available. Buildable Angular libraries use the Angular unit-test builder with Vitest; non-buildable Angular libraries use Nx's Vitest Analog integration.

## Verification

Angular's supported unit-test builder runs Vitest. App tests share an MSW server setup for HTTP mocks. Playwright verifies the app's user-visible composition. Nx supplies project-aware targets and affected execution.

## Governance

GitHub Issues are the canonical work source. The repository contains an issue template, a validator, and an operational `create-issue` skill. A GitHub Actions workflow validates issue changes and returns invalid work to triage. See the [issue workflow](../guides/issue-workflow.md) for metadata and lifecycle rules.

Protected infrastructure includes `.husky/`, `.github/workflows/`, `.agents/skills/`, `AGENTS.md`, lint and Nx policy, generators, policy scripts, and `docs/documentation-policy.md`. The private repository's current account cannot enable GitHub rulesets: GitHub returned HTTP 403 and requires Pro or public visibility. Stellar remains private as authorized. CI runs on `develop`, but server-side pull-request and status-check enforcement is not active; local instructions and hooks are not a security boundary. Keep autonomous work disabled until effective protections and independent review are available.

Vercel deployment and the monthly release process are planned. No Vercel account or automated release promotion is configured.
