---
name: create-component
description: Create an atomic Angular UI component with Stellar's Nx generator.
---

# Create an atomic component

1. Read the [generator guide](../../../docs/guides/generators.md). Inspect current projects and tags, available layer libraries, existing component names, and dependency direction. Choose a distinct lowercase kebab-case name and the layer specified by the task.
2. Preview the generator and review its planned files:

   ```sh
   corepack pnpm exec nx g @stellar/generators:atomic-component --name=<name> --layer=<atom|molecule|organism|template> --dry-run
   ```

3. If the preview is in scope and has no unexpected overwrite, rerun without `--dry-run`. Confirm the generated component and tests use the selected layer and naming, inspect imports against atomic dependency direction, then run relevant checks.

Stop on a name collision, invalid layer, unexpected overwrite, generator error, or invalid dependency direction. Preserve all work and report the command output instead of duplicating generator behavior manually.
