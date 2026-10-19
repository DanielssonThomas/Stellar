# ADR 0001: Nx, Angular, and library-first architecture

**Status:** Accepted

## Context

Stellar will host multiple Angular applications with small, issue-driven contributions. Contributors need consistent project discovery, dependency enforcement, and affected checks.

## Decision

Use Nx with Angular 21.2 and TypeScript in an integrated monorepo. Applications compose functionality from scoped libraries. UI libraries use atomic design, and ESLint enforces tag-based dependency direction. Use pnpm because npm 11.1 repeatedly failed dependency resolution in the bootstrap environment; Nx and Angular versions remain aligned with the available Node.js runtime.

## Consequences

Nx provides project targets, generators, and boundary checks. Shared code has an explicit public entry point. New library layers and generators should be introduced only when a concrete issue needs them. The stack should be reviewed during routine dependency maintenance.

## Related references

- [Architecture overview](../architecture/overview.md)
- [Nx and Angular compatibility](https://nx.dev/docs/kb/angular-nx-version-matrix)
