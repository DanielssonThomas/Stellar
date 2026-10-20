---
name: create-application
description: Create an Angular application and its mirrored Playwright E2E project with Stellar's Nx generator.
---

# Create an application

1. Read the [generator guide](../../../docs/guides/generators.md). Inspect current Nx projects, tags, and existing application names first. Choose a distinct lowercase kebab-case name from the task; do not assume a project name.
2. Preview the generator and review its planned file changes:

   ```sh
   corepack pnpm exec nx g @stellar/generators:application --name=<name> --dry-run
   ```

3. If the preview is in scope and does not overwrite existing work, run the same command without `--dry-run`. Confirm both the application and its mirrored Playwright E2E project appear in Nx, inspect their tags and generated files, then run their relevant checks.

Stop on a name collision, unexpected overwrite, generator error, or missing E2E project. Preserve generated and existing user work; report the command output and issue blocker rather than editing generator internals as a workaround.
