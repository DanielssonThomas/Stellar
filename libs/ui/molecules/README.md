# UI molecules

## Emblem motion

`EmblemMotionMolecule` presents independent SVG/PNG/WebP image layers from an `EmblemManifest`. The shell owns the component's bounds, center/dock position and size. The component owns only internal layer transforms; it does not capture audio, call native APIs, or own application state.

```html
<stellar-emblem-motion-molecule
  [manifest]="emblemManifest"
  assetBasePath="/assets/emblem"
  [phase]="interaction.phase"
  [audioLevel]="audioLevel"
  [waiting]="assistantWaiting"
  [reducedMotion]="reducedMotion"
  [active]="windowVisible"
  [loading]="assetsLoading"
  [error]="assetError"
/>
```

Use `decodeEmblemManifest(unknown)` to validate a bundled JSON manifest through the same geometry and resource checks before passing it to the component. Import the component and manifest types from `@stellar/ui-molecules`. Give its host explicit bounds and include the application's existing Tailwind/theme styles. `phase` uses the frontend interaction contract from `@stellar/desktop-interaction`; it is not a Rust IPC type. Audio levels are clamped to 0–1, with nonfinite values treated as silence.

Optional `rasterSizes` lists up to eight strictly increasing integer widths, at least 32 and below the viewBox width. PNG variants live at `resolutions/<width>/<original-file>` beneath the asset prefix. The component waits for a nonzero host width, then supplies measured CSS-pixel `sizes` and width-descriptor `srcset` for fragments and assembled-source preloads. The browser selects resolution with device pixel ratio and may retain larger cached candidates after shrinking. `ResizeObserver` follows container changes without restarting the layer animations; its subscription is disposed with the component. SVG/WebP sources and manifests without this field retain their original source URLs. The shared skeleton covers the initial measurement; missing variants use the existing asset-error fallback. Source viewBox, anchors and motion geometry remain independent of raster resolution.

Each manifest has version `1`, a four-number `viewBox`, and 1–96 layers. Layers identify an SVG, PNG or WebP file, stacking order `z`, anchor, and assembled/exploded `{ x, y, rotation, depth? }` poses. Optional depth uses source viewBox units, is finite and bounded to ±4096; older manifests remain valid. For indexed stacks, all layers instead supply unique contiguous planeIndex values and the manifest can supply planeSpacing (positive, at most 256; default 240). This index is independent of canonical paint order. Optional spacingProfile is uniform (the default) or outer-dense; outer-dense compresses depth gaps continuously toward both ends while keeping the stack centered. Optional planeCore supplies a centered count and fixed spacing with matching stack parity; the desktop experiment uses 81 planes with outer spacing 49.4 and a thirteen-plane core at spacing 80. Explicit pose depth overrides indexed spacing for individual secondary-ring arcs; all still share the same axis. Shared motionDurations from the interaction library coordinate one-second camera/layer movement, ambient neutralization and Stage motion. Coordinates use the viewBox units. Files are relative paths containing letters, digits, hyphens, underscores and slashes, ending in `.svg`, `.png` or `.webp`; asset prefixes use the same path segments and may start with `/`. Sources render through `<img>`, never injected SVG markup. Malformed geometry, duplicate IDs, unsafe paths, host errors and failed images render an accessible fallback. Replace the manifest object or asset prefix to retry failed assets.

Idle, returning, suspended and shutdown use an upper-left oblique camera and the exploded pose. Explicit depth scales with the component container; legacy manifests retain their small implicit paint-order depth. Focusing, listening, hangover, docking and presenting use a front-facing camera and assembled geometry. Reduced motion keeps explicit separated idle depth but disables animation; legacy implicit depth remains suppressed. Percentage translations, container-relative depth and origins adapt to resizing without cached viewport coordinates.

Separate camera, assembly and ambient wrappers own their transforms. Camera/layer transitions rebase from computed transforms, cancel obsolete animations and preserve the final style. Both motion controllers snapshot all changed computed transforms before cancellations or style writes, avoiding repeated style flushes across the stack; static/paused layer updates skip transform reads. A shared wrapper gently drifts the entire exploded stack while each ring rotates about its normal. The 81-plane experiment therefore owns fourteen idle animations (one drift and thirteen ring rotations); all 81 assembly paths remain independent. Rotation and shared drift settle back to identity during assembly. Only the camera/drift ancestry preserves the shared 3D scene; individual artwork planes flatten their own 2D image contents. Unchanged targets do not restart movement. Loading, errors, hidden/inactive/suspended/shutdown states and destruction cancel outstanding work. Application and system reduced motion both suppress all animations.

`environment` defaults to `false` and controls only the optional audio-reactive glow. Idle in-plane ring rotation and shared drift do not depend on it. Layers explicitly marked `spin` rotate in opposite directions. Motion uses owned Web Animations without a frame loop or new dependency.

`waiting` defaults to `false`. It adds a separate rotating four-star ring and scales the artwork to 86% at 68% opacity; clearing it restores full presence. Supply an assembled phase while waiting or narrating. Reduced motion keeps the ring static and removes the size/opacity transition; hidden, inactive, suspended and shutdown states suppress the ring.

The desktop supplies the reviewed #176 hybrid pack. Its canonical assembly is unchanged by #202; corrected depth metadata and the common camera reveal separated planes at idle. The source library retains the original reference and earlier study. Native visual acceptance and physical audio qualification remain separate gates.

## Verification

Run `pnpm exec nx run-many -t lint test build --projects=ui-molecules`. Tests cover manifest validation, relative geometry, interrupted motion, stable targets, loading/error recovery, visibility and destruction cleanup. The existing `test` target discovers the generated molecule and runs Angular's unit-test builder.

The 1 November 2026 browser fixture used the actual Angular component, interaction controller and 12 independent study SVGs. Captures cover center, focus, listening, docked, returning, reduced motion, 48/64/96 px sizes and DPR 2, with a recorded transition. On Windows 11 build 26200, Intel i7-14700K, headless Chromium 156.0.8078.4 at 1440×900/DPR 1, five seconds of steady listening with optional rings/glow yielded 298 frame intervals: median 16.7 ms, p95 16.8 ms, maximum 50.1 ms. The p95 preview target of 25 ms passed; a strict zero-frames-over-50-ms target did not (one outlier). This is browser preview evidence, not a native/GPU performance qualification. The optional environment remains off by default.

Optional registered clip rectangles split a source image into independent planes without changing its pixels. Invalid/noninteger/out-of-bounds rectangles fail manifest validation. Real animation settlement consolidates assembled repeated sources to one original, preventing scaled clip seams; returning restores clipped fragments. Legacy manifests retain the unclipped path.

AssistantMessageMolecule renders its complete requested title/body through Angular text bindings, wraps long strings and exposes a skeleton loading state. It interprets neither HTML nor Markdown; Stage owns scrolling.

Registered strand exports may carry assembly metadata with a safe original SVG/PNG/WebP image file, zero-based index and group count. Groups must be complete with unique indices. Only contiguous paint order, shared anchors and zero assembled poses permit consolidation. The component preloads the original and swaps the group only after camera/layer settlement; returning restores the strand files. The asset exporter must verify that the fragments reproduce their source pixels exactly.

Optional radialTaper (0–1) moves exploded fragment centers toward the viewBox center on an elliptical envelope as absolute plane depth increases. Raster layers supply an optional in-bounds centroid measured from visible pixels; rings omit it. The motion model compensates for exploded rotation/scatter before applying the translation. This changes position without scaling individual pieces, leaves depth unchanged and applies statically under reduced motion. Omitted taper/centroids preserve older manifests, and assembled geometry is unaffected.
