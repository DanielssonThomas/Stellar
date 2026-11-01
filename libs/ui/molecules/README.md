# UI molecules

## Emblem motion

`EmblemMotionMolecule` presents independent SVG/PNG/WebP image layers from an `EmblemManifest`. The shell owns the component's bounds, center/dock position and size. The component owns only internal layer transforms; it does not capture audio, call native APIs, or own application state.

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

Each manifest has version `1`, a four-number `viewBox`, and 1–32 layers. Layers identify an SVG, PNG or WebP file, stacking order `z`, anchor, and assembled/exploded `{ x, y, rotation, depth? }` poses. Optional depth uses source viewBox units, is finite and bounded to ±4096; older manifests remain valid. For uniformly spaced stacks, all layers instead supply unique contiguous planeIndex values and the manifest can supply planeSpacing (positive, at most 256; default 240). This index is independent of canonical paint order. Shared motionDurations from the interaction library coordinate one-second camera/layer movement, ambient neutralization and Stage motion. Coordinates use the viewBox units. Files are relative paths containing letters, digits, hyphens, underscores and slashes, ending in `.svg`, `.png` or `.webp`; asset prefixes use the same path segments and may start with `/`. Sources render through `<img>`, never injected SVG markup. Malformed geometry, duplicate IDs, unsafe paths, host errors and failed images render an accessible fallback. Replace the manifest object or asset prefix to retry failed assets.

Idle, returning, suspended and shutdown use an upper-left oblique camera and the exploded pose. Explicit depth scales with the component container; legacy manifests retain their small implicit paint-order depth. Focusing, listening, hangover, docking and presenting use a front-facing camera and assembled geometry. Reduced motion keeps explicit separated idle depth but disables animation; legacy implicit depth remains suppressed. Percentage translations, container-relative depth and origins adapt to resizing without cached viewport coordinates.

Separate camera, assembly and ambient wrappers own their transforms. Camera/layer transitions rebase from computed transforms, cancel obsolete animations and preserve the final style. The ambient controller independently settles rotation/float back to identity during assembly; idle rings rotate about their normals and character parts float gently. Unchanged targets do not restart movement. Loading, errors, hidden/inactive/suspended/shutdown states and destruction cancel outstanding work. Application and system reduced motion both suppress all animations.

`environment` defaults to `false` and controls only the optional audio-reactive glow. Idle in-plane ring rotation and character float do not depend on it. Layers explicitly marked `spin` rotate in opposite directions; other layers float. Motion uses owned Web Animations without a frame loop or new dependency.

The desktop supplies the reviewed #176 hybrid pack. Its canonical assembly is unchanged by #202; corrected depth metadata and the common camera reveal separated planes at idle. The source library retains the original reference and earlier study. Native visual acceptance and physical audio qualification remain separate gates.

## Verification

Run `pnpm exec nx run-many -t lint test build --projects=ui-molecules`. Tests cover manifest validation, relative geometry, interrupted motion, stable targets, loading/error recovery, visibility and destruction cleanup. The existing `test` target discovers the generated molecule and runs Angular's unit-test builder.

The 1 November 2026 browser fixture used the actual Angular component, interaction controller and 12 independent study SVGs. Captures cover center, focus, listening, docked, returning, reduced motion, 48/64/96 px sizes and DPR 2, with a recorded transition. On Windows 11 build 26200, Intel i7-14700K, headless Chromium 156.0.8078.4 at 1440×900/DPR 1, five seconds of steady listening with optional rings/glow yielded 298 frame intervals: median 16.7 ms, p95 16.8 ms, maximum 50.1 ms. The p95 preview target of 25 ms passed; a strict zero-frames-over-50-ms target did not (one outlier). This is browser preview evidence, not a native/GPU performance qualification. The optional environment remains off by default.

AssistantMessageMolecule renders only its requested title/body payload through Angular text interpolation and exposes a skeleton loading state. It interprets neither HTML nor Markdown.
