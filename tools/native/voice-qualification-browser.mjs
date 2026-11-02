export function voiceQualificationPreflight() {
  try {
    const root = document.querySelector('stellar-root');
    const composition =
      root && window.ng?.getComponent(root)?.voice?.composition();
    const buttons = [...document.querySelectorAll('button')].map((button) =>
      button.textContent?.trim(),
    );
    return (
      !!root &&
      buttons.includes('Enable microphone') &&
      !buttons.includes('Stop microphone') &&
      document.querySelectorAll('section[role="region"][data-instance-id]')
        .length === 0 &&
      composition?.status === 'idle' &&
      composition.raw === '' &&
      (composition.refined === null || composition.refined === '') &&
      composition.lastSubmittedRaw === ''
    );
  } catch {
    return false;
  }
}

/** Install only in an isolated, explicitly opted-in native qualification WebView. */
export async function installVoiceQualification() {
  if (window.__stellarVoiceQualification) throw new Error('Already installed');
  const media = navigator.mediaDevices;
  const internals = window.__TAURI_INTERNALS__;
  const tauri = window.__TAURI__;
  if (
    !media ||
    !internals ||
    typeof internals.invoke !== 'function' ||
    typeof internals.convertFileSrc !== 'function' ||
    typeof window.fetch !== 'function' ||
    typeof tauri?.event?.listen !== 'function'
  )
    throw new Error('Native APIs unavailable');
  const nativeFetch = window.fetch;
  const events = [];
  let acquisitions = 0;
  let active = 0;
  let session;
  let disposed = false;
  let overflow = false;
  const append = (kind, details = {}) => {
    if (events.length >= 512) {
      overflow = true;
      return;
    }
    events.push({ at: performance.now(), kind, active, ...details });
  };
  const commands = new Map(
    ['speech_transcribe', 'cleanup_refine', 'ivy_submit', 'speech_speak'].map(
      (command) => [internals.convertFileSrc(command, 'ipc'), command],
    ),
  );
  const observedFetch = async function (input, ...args) {
    const command = typeof input === 'string' ? commands.get(input) : undefined;
    if (command) {
      const group = document.querySelector('[aria-label="Spoken prompt"]');
      append('invoke', {
        command,
        dissolved: !!group?.classList.contains('dissolved'),
        opacityZero: !!group && Number(getComputedStyle(group).opacity) === 0,
      });
    }
    try {
      const response = await nativeFetch.call(this, input, ...args);
      if (command) {
        const info = {
          command,
          ok: response.headers.get('Tauri-Response') === 'ok',
        };
        let result;
        try {
          result = await response.clone().json();
        } catch {
          info.ok = false;
        }
        if (info.ok && command === 'speech_transcribe') {
          const text = typeof result?.text === 'string' ? result.text : '';
          const normalized = text
            .toLocaleLowerCase('en-US')
            .replace(/[’']/g, '')
            .replace(/[^\p{L}\p{N}\s]/gu, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          info.recognized = [
            'prompt',
            'end prompt',
            'send prompt',
            'send',
          ].includes(normalized)
            ? normalized
            : normalized
              ? 'content'
              : 'empty';
          if (info.recognized === 'content')
            info.intent = [
              'native voice check',
              'voice pipeline complete',
              'only workspace tools',
              'do not read or change any files or settings',
            ].every((part) => normalized.includes(part));
        }
        if (info.ok && command === 'cleanup_refine')
          info.cleaned =
            typeof result?.text === 'string' && !!result.text.trim();
        if (info.ok && command === 'ivy_submit')
          info.verifiedModel = ['sol', 'terra'].includes(result?.verified_model)
            ? result.verified_model
            : null;
        append('result', info);
      }
      return response;
    } catch (error) {
      if (command) append('result', { command, ok: false });
      throw error;
    }
  };
  const syntheticGetUserMedia = async (constraints) => {
    if (disposed || !constraints?.audio || constraints.video)
      throw new Error('Synthetic audio unavailable');
    const context = new AudioContext();
    const destination = context.createMediaStreamDestination();
    await context.resume();
    const tracks = destination.stream.getAudioTracks();
    if (tracks.length !== 1 || active !== 0) {
      for (const track of destination.stream.getTracks()) track.stop();
      await context.close();
      throw new Error('Synthetic capture state invalid');
    }
    const current = {
      context,
      destination,
      track: tracks[0],
      armed: false,
      stopped: false,
    };
    session = current;
    acquisitions++;
    active++;
    const originalStop = current.track.stop.bind(current.track);
    current.track.stop = () => {
      const result = originalStop();
      if (!current.stopped) {
        current.stopped = true;
        const ended = current.track.readyState === 'ended';
        if (ended) active--;
        append('track-stopped', { acquisition: acquisitions, ended });
        void context.close();
      }
      return result;
    };
    append('track-started', { acquisition: acquisitions });
    return destination.stream;
  };
  let dissolvedSeen = false;
  const observer = new MutationObserver(() => {
    const group = document.querySelector('[aria-label="Spoken prompt"]');
    if (!dissolvedSeen && group?.classList.contains('dissolved')) {
      dissolvedSeen = true;
      append('presentation-dissolved');
    }
  });
  observer.observe(document.documentElement, {
    subtree: true,
    attributes: true,
    attributeFilter: ['class'],
    childList: true,
  });
  let paneSeen = false;
  const paneTimer = setInterval(() => {
    if (paneSeen) return;
    const panes = [
      ...document.querySelectorAll('section[role="region"][data-instance-id]'),
    ];
    const match = panes.find(
      (pane) =>
        [...pane.querySelectorAll('h1, h2, h3, h4, h5, h6')].some(
          (heading) =>
            heading.textContent?.trim().toLocaleLowerCase('en-US') ===
            'native voice check',
        ) &&
        pane.textContent
          ?.toLocaleLowerCase('en-US')
          .includes('voice pipeline complete') &&
        pane.getAttribute('aria-hidden') !== 'true' &&
        Number(getComputedStyle(pane).opacity) > 0 &&
        pane.getBoundingClientRect().width > 0 &&
        pane.getBoundingClientRect().height > 0,
    );
    if (match && panes.length === 1) {
      paneSeen = true;
      append('expected-pane-visible', { paneCount: panes.length });
    }
  }, 150);
  const stopListeners = [];
  let playbackIdentity;
  try {
    Object.defineProperty(media, 'getUserMedia', {
      configurable: true,
      value: syntheticGetUserMedia,
    });
    if (media.getUserMedia !== syntheticGetUserMedia)
      throw new Error('Synthetic hook failed');
    window.fetch = observedFetch;
    if (window.fetch !== observedFetch)
      throw new Error('Native observer unavailable');
    for (const event of ['speech-state', 'ivy-state']) {
      stopListeners.push(
        await tauri.event.listen(event, ({ payload }) => {
          if (
            event === 'speech-state' &&
            [
              'idle',
              'transcribing',
              'synthesizing',
              'speaking',
              'unavailable',
            ].includes(payload?.state)
          ) {
            if (payload.state === 'synthesizing') {
              playbackIdentity =
                typeof payload.epoch === 'string' &&
                typeof payload.operation_id === 'string'
                  ? { epoch: payload.epoch, operation: payload.operation_id }
                  : undefined;
            }
            append('speech-state', {
              state: payload.state,
              samePlayback:
                !!playbackIdentity &&
                payload.epoch === playbackIdentity.epoch &&
                payload.operation_id === playbackIdentity.operation,
              error:
                payload.error === null
                  ? null
                  : payload.error === 'cancelled'
                    ? 'cancelled'
                    : 'error',
            });
          }
          if (
            event === 'ivy-state' &&
            [
              'idle',
              'submitting',
              'admitted',
              'completed',
              'failed',
              'cancelled',
              'uncertain',
            ].includes(payload?.turn)
          )
            append('ivy-state', {
              turn: payload.turn,
              verifiedModel: ['sol', 'terra'].includes(payload.verified_model)
                ? payload.verified_model
                : null,
            });
        }),
      );
    }
  } catch (error) {
    if (window.fetch === observedFetch) window.fetch = nativeFetch;
    // Never restore the original media capture entry point after installation starts.
    try {
      Object.defineProperty(media, 'getUserMedia', {
        configurable: true,
        value: async () => {
          throw new Error('Synthetic hook unavailable');
        },
      });
    } catch {
      /* The caller must close this window without enabling capture. */
    }
    observer.disconnect();
    clearInterval(paneTimer);
    for (const stop of stopListeners) stop();
    throw error;
  }
  const arm = async (base64, label) => {
    if (
      disposed ||
      !['prompt', 'content', 'finalize'].includes(label) ||
      !session ||
      session.stopped ||
      session.armed ||
      active !== 1 ||
      typeof base64 !== 'string' ||
      base64.length > 2800000
    )
      throw new Error('Cannot arm fixture');
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    const current = session;
    const buffer = await current.context.decodeAudioData(bytes.buffer);
    if (
      session !== current ||
      current.stopped ||
      current.armed ||
      buffer.duration <= 0 ||
      buffer.duration > 20
    )
      throw new Error('Synthetic fixture expired or invalid');
    current.armed = true;
    const source = current.context.createBufferSource();
    source.buffer = buffer;
    source.connect(current.destination);
    source.start(current.context.currentTime + 1.2);
    append('fixture-armed', { label, acquisition: acquisitions });
  };
  const snapshot = () => ({
    installed:
      media.getUserMedia === syntheticGetUserMedia &&
      window.fetch === observedFetch,
    acquisitions,
    active,
    overflow,
    events: events.map((event) => ({ ...event })),
  });
  const dispose = async () => {
    disposed = true;
    if (session && !session.stopped) session.track.stop();
    observer.disconnect();
    clearInterval(paneTimer);
    for (const stop of stopListeners) stop();
    if (window.fetch === observedFetch) window.fetch = nativeFetch;
    // Keep getUserMedia synthetic and fail closed until the isolated window closes.
  };
  window.__stellarVoiceQualification = Object.freeze({
    arm,
    snapshot,
    dispose,
  });
  append('installed');
  return snapshot();
}
