# UI organisms

## Local Stage

`StageOrganism` renders trusted, pre-imported Angular surface components. The only production surface is `ActivitySummaryMolecule`, which shows local activity duration, peak level and an optional input label. The Stage does not acquire audio, load remote components, evaluate templates or inject payload HTML. These commands are frontend-owned; they are not duplicated Rust IPC contracts.

```ts
import type { ProductionPayloadMap, StageCommand } from '@stellar/ui-organisms';

const command: StageCommand<ProductionPayloadMap> = {
  contractVersion: 1,
  commandId: 1,
  instanceId: 'local-activity',
  action: 'open',
  surface: 'activity-summary',
  prominence: 'primary',
  payload: {
    durationMs: 62000,
    peakLevel: 0.73,
    inputLabel: 'Manual activity',
  },
};

stage.dispatch(command);
```

The shell obtains the component through its Angular view query. Give the Stage explicit width and height; it owns surface placement and the `[stage-emblem]` projection slot's bounds. Project the emblem into that slot instead of separately calculating its center/dock position. Stage never animates the emblem's internal layers. Observe `(interaction)` for the semantic `{ type: 'dismiss' }` event when a surface closes.

Every command requires `contractVersion: 1`, a positive safe-integer `commandId`, a separate 1–64 character `instanceId`, and an action. Instance IDs use ASCII letters, digits, underscores or hyphens. `open` additionally requires a registered `surface`, validated `payload` and `prominence: 'primary' | 'secondary'`. `update` requires the same surface kind and a complete replacement payload. `focus`, `minimize` and `close` take no other fields. Unknown fields, versions, kinds and malformed values are rejected before rendering.

Activity payloads contain `durationMs` from 0 to 86,400,000 and `peakLevel` from 0 to 1, both finite. Optional `inputLabel` is 1–80 characters without control characters. Labels are plain Angular text. The summary component also exposes independent `loading` and `error` inputs and reuses `SkeletonAtom`.

## Bounds and lifetime

The registry permits at most four live instances, including minimized instances. JSON payloads are limited to 2,048 UTF-8 bytes and commands to 4,096; recursive shape checks reject accessors, non-JSON values, cycles, sparse arrays and unusual prototypes. Accepted data is copied and frozen; snapshots retain no caller aliases.

Allocate strictly increasing command IDs during a Stage lifetime. The registry retains at most 64 normalized commands/results plus a high-water ID. An identical retained command returns `duplicate` without executing again; reusing an ID with different content is rejected. Older evicted IDs are rejected as stale, so eviction cannot replay an old open. Valid but unsuccessful requests also consume their IDs. Local keyboard/button controls are trusted host interactions and remain available even when external sequence IDs are exhausted. Disposing the registry is terminal and clears its instances/history.

Focus restores a minimized surface. Minimize removes its Angular component while retaining validated data; restoring recreates the component. Close disposes it and emits dismissal once. Escape closes the focused surface and restores its original opener when connected. If an opener surface closes or minimizes first, dependent focus origins are redirected to its surviving opener. Destroying the Stage releases its resize observer, listener, registry and component instances.

The pure `directStage` helper calculates bounded, non-overlapping rectangles for up to four visible surfaces and the emblem. It responds to prominence and host resizing without implementing a general desktop window manager. Small layouts use one column; larger layouts can use two. Surface contents scroll inside their assigned bounds.

## Trusted extension and verification

`STAGE_CATALOGUE` is a host-only Angular injection token mapping known names to imported component types, titles and payload decoders. Adding a surface requires code review and a typed validator; catalogue entries never come from command data. Dynamic outlets receive only the selected trusted type and its sanitized `payload` input. `StageCommand<YourPayloadMap>` supports compile-time extension. The second component under `src/testing` exists only to prove multiple-instance layout and lifecycle disposal; it is excluded from production compilation and exports.

Run `pnpm exec nx run-many -t lint test build --projects=ui-molecules,ui-organisms`. Unit tests cover invalid commands, byte bounds, duplicate/stale/conflicting IDs, instance limits, immutable snapshots, layout, plain-text rendering, keyboard dismissal, nested focus restoration, resizing and disposal. The browser fixture exercises the actual Angular components through open/update/focus/minimize/close and keyboard dismissal; it does not claim audio or native-app verification.
