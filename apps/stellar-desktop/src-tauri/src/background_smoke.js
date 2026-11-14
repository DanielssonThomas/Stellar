(async () => {
  const invoke = window.__TAURI__.core.invoke;
  let stage = 'background-start';
  let latestIvy;
  try {
    let update;
    let speaking = false;
    let speechDone = false;
    let latestSpeech;
    let speaks = 0;
    const operations = new Set();
    await window.__TAURI__.event.listen('ivy-state', ({ payload }) => {
      latestIvy = payload;
      update =
        payload.background_updates?.find((item) =>
          item.text.includes('STELLAR_BACKGROUND_299'),
        ) ?? update;
    });
    await window.__TAURI__.event.listen('speech-state', ({ payload }) => {
      latestSpeech = payload;
      if (update && payload.state === 'speaking') {
        speaking = true;
        if (!operations.has(payload.operation_id)) {
          operations.add(payload.operation_id);
          speaks++;
        }
      }
      if (speaking && payload.state === 'idle') speechDone = true;
    });
    await invoke('background_smoke_start', { resumeOnly: false });
    const started = Date.now();
    while (!update || !speechDone) {
      if (Date.now() - started > 90000)
        throw Error('No verified background speech within ninety seconds');
      if (
        latestIvy?.connection === 'unavailable' ||
        latestSpeech?.state === 'unavailable'
      )
        throw Error('Native boundary unavailable');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    stage = 'background-visible';
    const notice = document.querySelector('[data-background-update]');
    if (
      !notice?.textContent.includes('STELLAR_BACKGROUND_299') ||
      notice.getBoundingClientRect().width === 0
    )
      throw Error('Update was not visibly rendered');
    if (!update.speech_claim || speaks !== 1)
      throw Error('Background speech claim was not unique');
    await invoke('ivy_disconnect', { request: { version: 1 } });
    await invoke('background_smoke_start', { resumeOnly: true });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const restored = await invoke('ivy_snapshot', { request: { version: 1 } });
    if (
      !restored.background_updates?.some(
        (item) =>
          item.id === update.id && item.speech_claim === update.speech_claim,
      ) ||
      speaks !== 1
    )
      throw Error('Reconnect lost the update or repeated its speech');
    stage = 'background-spoken-once';
    await invoke('smoke_result', {
      success: true,
      stage,
      diagnostics: [true, speaking, speechDone, speaks === 1],
    });
  } catch (error) {
    console.error('Background qualification:', stage, String(error));
    if (
      latestIvy?.error &&
      [
        'unavailable',
        'protocol',
        'busy',
        'storage',
        'timeout',
        'uncertain',
      ].includes(latestIvy.error)
    )
      stage = 'background-' + latestIvy.error;
    if (
      typeof error === 'string' &&
      [
        'unavailable',
        'protocol',
        'busy',
        'storage',
        'timeout',
        'uncertain',
      ].includes(error)
    )
      stage = 'background-' + error;
    await invoke('smoke_result', { success: false, stage });
  }
})();
