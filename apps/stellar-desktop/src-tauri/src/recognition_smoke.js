/* Compiled test-build script. No microphone, playback, Ivy, or network operations. */
(async () => {
  const invoke = window.__TAURI__.core.invoke;
  const input = __FIXED_PCM__;
  const report = {
    success: false,
    visible: !document.hidden,
    microphone_guard_installed:
      window.__STELLAR_SPEECH_GUARD__?.installed === true,
    microphone_attempted: window.__STELLAR_SPEECH_GUARD__?.attempted !== false,
    failure: null,
    wake: false,
    cancelled: false,
    stale_epoch_rejected: false,
    recovered: false,
    measurements: [],
  };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let epoch;
  async function measure(stage, action) {
    const intervals = [];
    let running = true,
      last;
    const frame = (now) => {
      if (!running) return;
      if (last !== undefined && intervals.length < 1800)
        intervals.push(now - last);
      last = now;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    const start = performance.now();
    const started_at_unix_ms = Date.now();
    try {
      return await action();
    } finally {
      running = false;
      intervals.sort((left, right) => left - right);
      report.measurements.push({
        stage,
        started_at_unix_ms,
        milliseconds: performance.now() - start,
        frame_count: intervals.length,
        frame_p50_ms: intervals[Math.floor(intervals.length * 0.5)] ?? null,
        frame_p95_ms: intervals[Math.floor(intervals.length * 0.95)] ?? null,
        frame_max_ms: intervals.at(-1) ?? null,
      });
    }
  }
  const snapshot = () => invoke('speech_snapshot', { request: { version: 1 } });
  const transcribe = () =>
    invoke('speech_transcribe', {
      request: {
        version: 1,
        epoch,
        utterance_id: crypto.randomUUID(),
        sample_rate_hz: 16000,
        pcm: input.long,
      },
    });
  try {
    for (
      let n = 0;
      n < 100 && !document.querySelector('stellar-emblem-motion-molecule');
      n++
    )
      await sleep(100);
    if (!document.querySelector('stellar-emblem-motion-molecule'))
      throw new Error();
    if (
      document.hidden ||
      !report.microphone_guard_installed ||
      report.microphone_attempted ||
      document.body.textContent.includes('Stop microphone')
    )
      throw new Error();
    epoch = (await snapshot()).epoch;
    await sleep(2000);
    await measure('idle_cold', () => sleep(5000));
    if (report.measurements[0].frame_count < 10) throw new Error();
    const data = input.wake.concat(Array(16000).fill(0));
    const detections = [];
    const keyword = async (at) => {
      const reply = await invoke('speech_keywords', {
        request: {
          version: 1,
          epoch,
          stream_id: 'recognition-smoke',
          sequence: at / 640,
          pcm: data.slice(at, at + 640),
          threshold: 0.008,
          mode: 'passive',
        },
      });
      if (reply.detection) detections.push(reply.detection.command);
    };
    await measure('keywords_cold', () => keyword(0));
    await measure('keywords_warm', async () => {
      for (let at = 640; at < data.length; at += 640) {
        await keyword(at);
        await sleep(40);
      }
    });
    report.wake = detections.length === 1 && detections[0] === 'ivy';
    const first = await measure('transcriber_cold', () => transcribe('cold'));
    if (!first.text.trim()) throw new Error();
    for (let n = 0; n < 3; n++) {
      const result = await measure('transcriber_warm', () =>
        transcribe('warm-' + n),
      );
      if (result.text !== first.text) throw new Error();
    }
    await measure('idle_warm', () => sleep(5000));
    const oldEpoch = epoch;
    await measure('cancellation', async () => {
      const pending = transcribe('cancel').then(
        () => false,
        (error) => error === 'cancelled',
      );
      await sleep(10);
      epoch = (await invoke('speech_stop', { request: { version: 1, epoch } }))
        .epoch;
      report.cancelled = await pending;
    });
    try {
      await invoke('speech_keywords', {
        request: {
          version: 1,
          epoch: oldEpoch,
          stream_id: 'stale',
          sequence: 0,
          pcm: [0],
          threshold: 0.008,
          mode: 'passive',
        },
      });
    } catch (error) {
      report.stale_epoch_rejected = error === 'cancelled';
    }
    const recovered = await measure('recovery', () => transcribe('recovery'));
    report.recovered = recovered.text === first.text;
    report.visible = report.visible && !document.hidden;
    report.success =
      report.visible &&
      report.wake &&
      report.cancelled &&
      report.stale_epoch_rejected &&
      report.recovered;
  } catch (error) {
    report.success = false;
    report.failure = [
      'cancelled',
      'busy',
      'unavailable',
      'protocol',
      'timeout',
      'invalid_request',
    ].includes(error)
      ? error
      : 'assertion';
  } finally {
    if (epoch !== undefined)
      try {
        await invoke('speech_stop', { request: { version: 1, epoch } });
      } catch {
        report.success = false;
      }
    report.microphone_attempted =
      window.__STELLAR_SPEECH_GUARD__?.attempted !== false;
    report.success &&=
      report.microphone_guard_installed && !report.microphone_attempted;
    input.wake.fill(0);
    input.long.fill(0);
    await invoke('recognition_result', { report });
  }
})();
