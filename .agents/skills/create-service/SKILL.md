---
name: create-service
description: Create a shared Angular service library with Stellar's Nx generator.
---

# Create a shared service

1. Read the [generator guide](../../../docs/guides/generators.md). Inspect current Nx projects, tags, and service/library names first. Choose a distinct lowercase kebab-case name from the task; do not assume one.
2. Preview the generator and review its planned file changes:

   ```sh
   corepack pnpm exec nx g @stellar/generators:service --name=<name> --dry-run
   ```

3. If the preview is in scope and does not overwrite existing work, rerun without `--dry-run`. Confirm the new shared service project appears in Nx, inspect generated source and tests, then run relevant checks.

Stop on a name collision, unexpected overwrite, or generator error. Preserve all work and report the command output rather than creating the service by hand as a workaround.
