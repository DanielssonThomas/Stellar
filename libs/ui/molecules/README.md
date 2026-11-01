# UI molecules

## Emblem motion

`EmblemMotionMolecule` presents independent SVG image layers from an `EmblemManifest`. The shell owns the component's bounds, center/dock position and size. The component owns only internal layer transforms; it does not capture audio, call native APIs, or own application state.

```html
<stellar-emblem-motion-molecule
  [manifest]="emblemManifest"
  assetBasePath="/assets/emblem"
  [phase]="interaction.phase"
  [audioLevel]="audioLevel"
  [reducedMotion]="reducedMotion"
  [active]="windowVisible"
  [loading]="assetsLoading"
  [error]="assetError"
/>
```

Use `decodeEmblemManifest(unknown)` to validate a bundled JSON manifest through the same geometry and resource checks before passing it to the component. Import the component and manifest types from `@stellar/ui-molecules`. Give its host explicit bounds and include the application's existing Tailwind/theme styles. `phase` uses the frontend interaction contract from `@stellar/desktop-interaction`; it is not a Rust IPC type. Audio levels are clamped to 0–1, with nonfinite values treated as silence.

Each manifest has version `1`, a four-number `viewBox`, and 1–32 layers. Layers identify an SVG, PNG or WebP file, stacking order `z`, anchor, and assembled/exploded `{ x, y, rotation }` poses. Coordinates use the viewBox units. Files are relative paths containing letters, digits, hyphens, underscores and slashes, ending in `.svg`, `.png` or `.webp`; asset prefixes use the same path segments and may start with `/`. Sources render through `<img>`, never injected SVG markup. Malformed geometry, duplicate IDs, unsafe paths, host errors and failed images render an accessible fallback. Replace the manifest object or asset prefix to retry failed assets.

Idle, returning, suspended and shutdown use the exploded pose with at most 9 px of centered depth. Focusing, listening, hangover, docking and presenting use the assembled geometry. Reduced motion preserves the selected pose without depth or animation. Percentage translations and origins adapt to host resizing and device-pixel-ratio changes without cached viewport coordinates. Keep the host aspect ratio consistent with the manifest to preserve the intended geometry.

One motion controller per component rebases interruptions from computed transforms, cancels obsolete animations, and leaves a stable final style. Identical targets do not restart motion when activity or audio updates arrive. Loading, error, hidden/inactive states and destruction cancel outstanding animations. The component observes document visibility and system reduced-motion changes; `active=false` additionally covers shell/native minimization. Application-requested reduced motion and the system preference both suppress animation.

`environment` defaults to `false`. Enabling it adds a restrained audio-reactive glow and slow opposing rings for layers explicitly marked `spin: 'clockwise'` or `'counter-clockwise'` (180/210 seconds). It uses CSS and native Web Animations, with no particle loop, frame callback or animation dependency. Hidden/inactive/reduced states stop the decorative ring animations. The optional environment can remain disabled on constrained hosts.

The current #176 study is an interchangeable development fixture, **not approved final artwork**. The library contains no copy of it. Fine hair and gemstone detail in that study is not legible at 48 px; final artwork acceptance remains with #176.

## Verification

Run `pnpm exec nx run-many -t lint test build --projects=ui-molecules`. Tests cover manifest validation, relative geometry, interrupted motion, stable targets, loading/error recovery, visibility and destruction cleanup. The existing `test` target discovers the generated molecule and runs Angular's unit-test builder.

The 1 November 2026 browser fixture used the actual Angular component, interaction controller and 12 independent study SVGs. Captures cover center, focus, listening, docked, returning, reduced motion, 48/64/96 px sizes and DPR 2, with a recorded transition. On Windows 11 build 26200, Intel i7-14700K, headless Chromium 156.0.8078.4 at 1440×900/DPR 1, five seconds of steady listening with optional rings/glow yielded 298 frame intervals: median 16.7 ms, p95 16.8 ms, maximum 50.1 ms. The p95 preview target of 25 ms passed; a strict zero-frames-over-50-ms target did not (one outlier). This is browser preview evidence, not a native/GPU performance qualification. The optional environment remains off by default.
