# Audio activity

`@stellar/service-audio-activity` provides opt-in Web Audio capture, an independent amplitude detector, a synthetic source and an Angular facade. It does not classify speech, persist audio, upload data, transcribe, or call a model. Its optional continuous PCM subscription supports a bounded local utterance consumer. Its models are frontend state and do not duplicate native IPC contracts.

## Ownership and integration

Provide `AudioActivityService` in the owning desktop component to scope cleanup to that component. Call `startMicrophone()` directly from a user click; it creates and resumes the AudioContext before awaiting permission. An optional device ID is passed only to acquisition, not exposed in snapshots or logs. Input names are omitted. `stop()` and `mute()` release capture; muted input is not retained for a silent background session. Starting a replacement source synchronously invalidates the old callbacks and begins releasing its resources. A permission result arriving after cancellation has every returned track stopped.

The readonly `state()` signal exposes typed capture status and activity summaries. Capture statuses distinguish requesting, capturing, suspended, denied, missing, disconnected, muted, unavailable and idle. A suspended context emits no audio frames and immediately clears current activity. Restart is an explicit action; no automatic retry reacquires a device. The source owns its context, tracks, analyser, graph nodes, listeners and timer. Stop attempts every resource release even when a device has already closed.

The Angular facade runs source creation and sampling outside `NgZone`; signal publication re-enters Angular. Continuous visual-level updates are limited to 20 Hz, while status and activity transitions publish immediately. The independent `AudioActivityController` can be used without Angular. It rejects stale source callbacks and exposes immutable snapshots. `bindLifecycle(document, window)` stops capture on hidden/pagehide and removes listeners on disposal. Native minimize integrations call `suspend()`; returning to the foreground does not restart capture. Dispose also prevents subsequent starts.

`SyntheticAudioSource` implements the same boundary without accessing browser devices. A manual-demo owner starts it and supplies timestamped scalar frames. This mode still works after a denied microphone request. The emblem or Stage should consume only activity/level/summary state; they must not own media resources.

## Detector semantics

`listInputs()` enumerates audio input descriptors only when its caller explicitly requests it. It does not acquire a stream or change capture state. The detached descriptors contain device ID and label, with a neutral fallback for names hidden before permission; callers must not persist them. Missing enumeration support and browser failures reject, while an empty list remains distinguishable. The desktop's chooser passes a selected ID to the existing `startMicrophone(deviceId)` boundary.

The first **600 ms of continuous valid frames** calibrate a fixed median noise floor from at most 256 samples. The user should remain quiet during calibration. A gap over 100 ms restarts unfinished calibration and cancels activity/candidates; missing time is never counted as activity. The floor stays fixed until the session resets. Continuous background noise can prevent detection; the detector never lowers a noisy baseline merely to force a result.

Activation requires RMS above `max(0.015, noiseFloor × 3)` for **120 ms**. Release requires RMS below `max(0.008, noiseFloor × 1.8)` for a **600 ms silence hangover**. Levels between those thresholds preserve an active state. This is amplitude activity, including possible keyboard or environmental noise, not voice recognition.

The visual level maps RMS from −60 dBFS through 0 dBFS to finite 0..1; exact silence is zero. Peak level is the maximum normalized instantaneous peak for the session. Clipping means a sample magnitude reached 0.999. Nonfinite frames and non-increasing timestamps do not alter the detector. Time comes from `performance.now()` in the real source. Duration is cumulative accepted intervals while the previous state was active, including the configured hangover, excluding gaps over 100 ms and candidate time. It is not speech duration. Stop preserves duration/peak while clearing current activity/level; a new session resets summaries.

Scalar activity summaries remain independent of the optional PCM path. The analyser sample array stays inside its closure; it is never attached to events or persisted. The library contains no network/storage client. Synthetic sources and injected clocks are test/integration boundaries, not evidence of physical hardware behavior.

## Continuous PCM and local utterances

`subscribePcm(listener)` returns an unsubscribe function. It does not start capture. An explicitly started `WebAudioSource` taps its existing selected MediaStream through the static `audio-worklets/stellar-pcm-worklet.js` asset; there is no second getUserMedia call. Applications copy the library's two worklet JavaScript files into that directory through build assets. No blob URLs, remote scripts or CSP relaxation are needed.

The worklet averages channels, continuously resamples the actual context rate into mono 16 kHz PCM16, and emits at most 640 samples per chunk. Fractional sample weight is retained across render quanta. Its output graph is silent, never microphone monitoring. At most four unacknowledged chunks may wait for the main thread; overflow is dropped and exposed as a sequence discontinuity rather than concatenated into fabricated continuous audio. Stop closes the port, disconnects the tap and releases the original tracks/context. Unsupported or failed worklets emit `unavailable`; amplitude activity remains usable.

Events are `{type:'chunk',chunk:{sampleRate:16000,sequence,samples:Int16Array}}`, `reset` or `unavailable`. Each subscriber receives its own sample copy. Source-generation fencing ignores late callbacks. Stop, replacement, suspension and disposal reset consumers. Callbacks execute outside Angular; do not log or persist PCM. Consumers own their delivered copies and should overwrite retained audio after use.

`createUtteranceAssembler().push(chunk,{active,calibrating})` returns a detached Int16Array only when a candidate finishes. It retains at most 20 seconds/320000 samples, including 240 ms preroll. Calibration, malformed/empty chunks and sequence discontinuities discard buffered audio. A candidate needs 200 ms of amplitude activity and finishes after 1400 ms with activity false, approximately two seconds after actual silence with the detector's 600 ms hangover. A capped utterance waits for quiet before rearming. This is only amplitude-based segmentation; the configured local speech recognizer still owns speech/VAD classification.

The speech coordinator must call `reset()` and drop incoming chunks while unavailable, hidden, busy, or playing a reply; it owns exactly-once submission and any native effects. Subscriptions need not stop the existing activity stream when gated. Reset overwrites both fixed internal buffers; returned utterances remain owned by the caller. No silence/noise classification is represented as recognized text.

## Verification

```sh
pnpm exec nx run-many -t lint test build e2e --projects=service-audio-activity
```

The E2E target runs a local Angular/Vite fixture in Playwright Chromium. Install the repository's pinned Chromium with `pnpm exec playwright install chromium`, or set process-local `STELLAR_BROWSER_CHANNEL=chrome` to use an installed Chrome. It verifies no automatic capture, a mocked denial, manual activity, calibration, duration, hangover, mute, minimize, stop and no external requests. A synthetic oscillator feeds a real MediaStream and AudioWorklet at 44.1 kHz to verify contiguous 16 kHz PCM and track cleanup without microphone or speaker use. The test-only fixture does not ship in the Angular package; its compiler/browser/test-runner imports are excluded only from production dependency inference, while ordinary lint checks remain active.

Vitest covers synthetic noise/timing/clipping fixtures, stale and invalid samples, capture cancellation, graph failures, late callbacks, resource/listener cleanup, suspension, visual rate limits and injector disposal. Foreman supplied the initial typed model, detector and sensitive capture source in one recorded source-only contribution; the host reviewed, corrected and integrated it. The receipt is retained in `evidence/foreman-contribution.json`.

The earlier isolated Windows native probe established user-observed audio activity. This production library's physical permission-denial, absent/unplugged-device and OS microphone-indicator cleanup matrix remains unverified; browser mocks are not substitutes. Shell integration must run that matrix before completing the milestone. No production deployment or complete hardware qualification is claimed here.
