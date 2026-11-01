# Nx generators

Use the local `@stellar/generators` plugin to create common projects with Stellar's Angular, Nx, naming, and test defaults. These generators build on the installed Nx 22.6 and Angular 21 APIs. They create only the requested project and its useful source files.

Run the commands from the repository root. Names use lowercase kebab-case.

## Applications

Create an Angular app and its Playwright E2E project:

```sh
corepack pnpm exec nx g @stellar/generators:application --name=admin-portal
```

The app is written to `apps/admin-portal`; its E2E project is `apps/admin-portal-e2e`. The generator applies `scope:app` and `type:app` tags, the `stellar` selector prefix, CSS, ESLint, routing, standalone components, and Angular's Vitest builder. Playwright is the E2E runner.

## Atomic UI components

Create a component in one of the four atomic layers:

```sh
corepack pnpm exec nx g @stellar/generators:atomic-component --name=account-summary --layer=molecule
```

The `--layer` option accepts `atom`, `molecule`, `organism`, or `template`. Files use the matching layer suffix, such as `account-summary-molecule.component.ts` and `AccountSummaryMolecule`. An existing layer library may retain its registered location (such as `ui-templates` under `libs/mission-control`), provided it is a shared UI library with matching layer tags, a safe path below `libs/`, and a source entry point inside its root. Its existing dependencies are preserved. If the requested layer library does not exist, the generator creates a buildable Angular library with the matching `scope:shared`, `type:ui`, and `layer:*` tags. It removes Nx's starter component and exports the generated component from the library entry point.

Each generated component is standalone, includes a `loading` input rendered with `SkeletonAtom`, and has tests for its content and loading state. Atoms reuse the local skeleton file; higher layers import it from `@stellar/ui-atoms`, following the allowed dependency direction.

The `ui-molecules` library is prepared before issue #138 so its generator writes only under `libs/ui/molecules/src/`. The prepared library deliberately exports no `agent-status` component. Its declared Angular and atoms peers are reserved for generated molecules, so the empty baseline excludes only those two peers from Nx's obsolete-dependency lint check; other lint rules remain active. Its `test` target reports an explicit baseline skip while no component exists; once a molecule is generated, the target requires a matching component spec and runs Angular's real `unit-test` target. Trusted candidate verification additionally requires `agent-status` to exist before it runs those tests. The worker's intended writable directory is `libs/ui/molecules/src`, leaving its project configuration and package manifest read-only.

## Shared services

Create an injectable service in its own shared Angular library:

```sh
corepack pnpm exec nx g @stellar/generators:service --name=profile-store
```

This creates `libs/services/profile-store`, tagged `scope:shared` and `type:util`, with a build target, `ProfileStoreService`, a test for root singleton injection, and a public entry-point export. It does not create an empty library or assume a service framework beyond Angular.
