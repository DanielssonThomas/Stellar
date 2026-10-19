# Repository guidance

## Architecture

- Inspect current projects and their tags before choosing where code belongs.
- Apps contain bootstrap, routing, configuration, and composition. Put UI and reusable behavior in scoped libraries.
- UI components follow atomic design: atoms, molecules, organisms, then templates. Import only from lower layers. Component classes and filenames use the layer suffix, for example `ButtonAtom` in `button-atom.component.ts`.
- Visual components expose a loading state appropriate to their content. Reuse skeleton primitives instead of rebuilding them.
- Use Tailwind utilities with semantic CSS tokens from the application theme; use `clsx` for conditional classes.
- ESLint enforces project tags and atomic component names. Do not bypass these checks.

## Work and verification

- Start implementation from a validated, assigned GitHub issue. Inspect its target and dependencies, then use an issue-specific branch and worktree. Do not commit to protected integration branches.
- Follow the [issue workflow](docs/guides/issue-workflow.md) for metadata, ownership, dependencies, and blockers.
- Add meaningful Vitest coverage for executable behavior. Use the shared MSW setup for HTTP interactions. Every application has a Playwright E2E project.
- Before a PR, run affected lint and unit tests plus the relevant build and E2E checks. Report commands and actual results.
- Commit subjects follow `[#123] type(scope): short description`; use an allowed conventional type and no emoji. PRs target the issue's authorized branch and describe verification and documentation impact.
- Do not change protected governance paths casually. Their review requirements are in [protected infrastructure](docs/architecture/overview.md#governance).

## Skills and documentation

- Discover repository workflows under `.agents/skills/`; read the relevant `SKILL.md` before acting.
- Follow [documentation policy](docs/documentation-policy.md) and use the [documentation index](docs/README.md) to find authoritative material. Update existing documents when appropriate; do not duplicate policies.
