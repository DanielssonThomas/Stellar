# Desktop interaction

`@stellar/desktop-interaction` coordinates microphone status, manual/audio activity, emblem presentation and one summary surface. It contains a pure reducer and a clock-backed controller. It has no Angular, capture, layout, animation-library or native dependencies in its implementation. These are frontend-owned models, not duplicates of Rust IPC contracts.

## Transition contract

| Current state         | Event                     | Result                                                           |
| --------------------- | ------------------------- | ---------------------------------------------------------------- |
| Idle or returning     | Activity starts           | Cancel obsolete motion; focus the emblem                         |
| Focusing              | Current motion completes  | Listen while active, otherwise begin hangover                    |
| Listening             | Both activity sources end | Begin silence hangover                                           |
| Hangover              | Activity resumes          | Cancel hangover; continue listening                              |
| Hangover              | Current timer expires     | Dock the emblem                                                  |
| Docking               | Current motion completes  | Open one summary, or reuse the existing instance                 |
| Docking or presenting | Activity starts           | Focus again; retain an existing summary instance                 |
| Any active phase      | Dismiss                   | Close summary, stop capture, clear activity and return to center |
| Any active phase      | Hidden or minimized       | Cancel timers/motion, close summary, stop capture and suspend    |
| Suspended             | Resume                    | Return to idle; do not restart capture automatically             |
| Any state             | Shutdown                  | Clean up and permanently reject further activity                 |

Microphone permission/request state is separate from interaction phase. `capture-request` emits a fresh `requestId`; every device result and audio activity event must carry that ID. Denial, missing device, disconnect, mute and stop terminate audio capture. Manual activity continues independently. Starting or ending either activity source twice is harmless. Old device, motion and hangover callbacks cannot restore earlier state.

The initial silence hangover is **900 ms**. This temporal hysteresis absorbs activity jitter before docking. Focus, dock and return motion deadlines are **1000 ms each**. A brief activity burst finishes focusing before its hangover begins. `hangoverMs` can be configured through an initial state; motion durations are exported as the initial presentation contract. These values are UI defaults, not speech detection thresholds.

Reduced motion changes presentation synchronously: no animation callback is needed to reach listening, presenting or idle. Silence hangover remains in effect. Enabling reduced motion during an animation cancels it and immediately reaches its current target.

## Host integration

```ts
import { createInteractionController } from '@stellar/desktop-interaction';

const interaction = createInteractionController({
  clock: {
    schedule(callback, delayMs) {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    },
  },
  onEffect: handlePresentationOrCaptureEffect,
  onChange: renderInteractionState,
});

interaction.dispatch({ type: 'manual-start' });
interaction.dispatch({ type: 'manual-end' });
// The owning component disposes the controller when its lifetime ends.
interaction.dispose();
```

The controller owns hangover timers and fallback motion-completion timers. A renderer may dispatch `motion-complete` early with the exact generation; that cancels the fallback. The clock must defer callbacks and return a cancellation function. Renderer/capture effects remain host adapters: respect cancellation IDs, apply the current stable target when `motion` is null, and stop resources associated with `stop-capture` even if acquisition is still pending. Layout coordinates and actual animation progress belong outside this library.

Effect callbacks may synchronously dispatch results; the controller queues them until the current transition finishes. Consumers treat exposed state as immutable and translate adapter failures into the matching microphone events. `dispose()` is idempotent and cancels pending controller timers. This library does not acquire microphone access or provide a native smoke test.

## Verification

Run `pnpm exec nx run-many -t lint test build --projects=util-desktop-interaction`. Vitest covers transitions, interrupted and stale completions, overlapping sources, resource disposal, reduced motion and deterministic timing. Browser/manual controls and native integration are downstream consumers of this public API.
