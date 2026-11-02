/** Validate only observed, sanitized events; never infer physical microphone behavior. */
export function assessVoiceQualification(trace) {
  const failures = [];
  const events = trace?.events;
  if (!Array.isArray(events) || trace.overflow || !trace.installed)
    return { passed: false, failures: ['observer-unavailable'] };
  const calls = (kind, command) =>
    events.filter((event) => event.kind === kind && event.command === command);
  const recognition = calls('result', 'speech_transcribe');
  const collected = calls('result', 'speech_collect');
  const end = (label) =>
    events.find(
      (event) => event.kind === 'fixture-ended' && event.label === label,
    );
  const finalized = collected.find(
    (event) =>
      event.ok &&
      event.recognized === 'send prompt' &&
      events.some(
        (start) =>
          start.kind === 'fixture-started' &&
          start.label === 'finalize' &&
          event.at >= start.at,
      ),
  );
  const commits = events.filter(
    (event) => event.kind === 'draft-commit' && event.length > 0,
  );
  const first = commits.find((event) => event.firstIntent && !event.fullIntent);
  const full = commits.at(-1);
  const preview = events.find(
    (event) =>
      event.kind === 'live-preview' && event.active === 1 && event.length > 0,
  );
  const refinements = events.filter(
    (event) => event.kind === 'draft-refined' && event.active === 1,
  );
  if (
    commits.length < 2 ||
    commits.some((event) => !event.appendOnly || !event.noDuplicates) ||
    recognition.length !== 1 ||
    !recognition[0].ok ||
    recognition[0].recognized !== 'prompt' ||
    !finalized ||
    !first ||
    !full ||
    !full.fullIntent ||
    full.at <= first.at ||
    full.length <= first.length ||
    !preview ||
    !end('content-1') ||
    !end('content-2') ||
    !events.some(
      (event) =>
        event.kind === 'fixture-started' &&
        event.label === 'content-2' &&
        event.collectInFlight === true,
    )
  )
    failures.push('recognition-or-intent');
  const cleanupInvokes = calls('invoke', 'cleanup_refine');
  const cleanup = calls('result', 'cleanup_refine');
  const firstRequest = cleanupInvokes.find(
    (event) =>
      event.active === 1 &&
      event.cleanupStage === 'first' &&
      Number.isSafeInteger(event.cleanupId),
  );
  const firstResult =
    firstRequest &&
    cleanup.find(
      (event) =>
        event.cleanupId === firstRequest.cleanupId &&
        event.ok &&
        event.cleaned &&
        event.at >= firstRequest.at &&
        finalized &&
        event.at < finalized.at,
    );
  const acceptedFull = refinements.some((revision) => {
    if (
      !full ||
      !finalized ||
      revision.at < full.at ||
      revision.at >= finalized.at ||
      revision.rawLength !== full.length ||
      !revision.fullIntent ||
      !Number.isSafeInteger(revision.cleanupId)
    )
      return false;
    const invocation = cleanupInvokes.find(
      (event) =>
        event.cleanupId === revision.cleanupId &&
        event.active === 1 &&
        event.cleanupStage === 'full',
    );
    const result = cleanup.find(
      (event) =>
        event.cleanupId === revision.cleanupId && event.ok && event.cleaned,
    );
    return (
      !!invocation &&
      !!result &&
      result.at >= invocation.at &&
      revision.at >= result.at
    );
  });
  if (!firstResult || !acceptedFull) failures.push('cleanup-unconfirmed');
  const busy = events.filter(
    (event) =>
      event.kind === 'invoke' &&
      ['speech_transcribe', 'ivy_submit', 'speech_speak'].includes(
        event.command,
      ),
  );
  if (busy.some((event) => event.active !== 0))
    failures.push('capture-not-released');
  const submit = calls('invoke', 'ivy_submit');
  if (
    submit.length !== 1 ||
    !submit[0].dissolved ||
    !submit[0].opacityZero ||
    !finalized ||
    submit[0].at < finalized.at ||
    !acceptedFull
  )
    failures.push('presentation-or-submit');
  const complete = events.find(
    (event) =>
      event.kind === 'ivy-state' &&
      event.turn === 'completed' &&
      event.verifiedModel === 'sol',
  );
  if (!complete || !submit[0] || complete.at < submit[0].at)
    failures.push('verified-sol-completion');
  const pane = events.find(
    (event) => event.kind === 'expected-pane-visible' && event.paneCount === 1,
  );
  if (!pane || !submit[0] || pane.at < submit[0].at)
    failures.push('expected-pane-missing');
  const speak = calls('result', 'speech_speak');
  const synth = events.findIndex(
    (event) => event.kind === 'speech-state' && event.state === 'synthesizing',
  );
  const playing = events.findIndex(
    (event, index) =>
      index > synth &&
      event.kind === 'speech-state' &&
      event.state === 'speaking',
  );
  const idle = events.findIndex(
    (event, index) =>
      index > playing &&
      event.kind === 'speech-state' &&
      event.state === 'idle',
  );
  if (
    speak.length !== 1 ||
    !speak[0].ok ||
    synth < 0 ||
    playing < 0 ||
    idle < 0 ||
    events
      .slice(synth, idle + 1)
      .some(
        (event) =>
          event.kind === 'speech-state' &&
          (!event.samePlayback || event.error !== null),
      )
  )
    failures.push('playback-unconfirmed');
  if (
    trace.active !== 1 ||
    trace.acquisitions !== 3 ||
    ['content-1', 'content-2', 'finalize'].some(
      (label) =>
        !events.some(
          (event) =>
            event.kind === 'fixture-armed' &&
            event.label === label &&
            event.acquisition === 2 &&
            event.active === 1,
        ),
    ) ||
    events.filter(
      (event) => event.kind === 'track-stopped' && event.ended === true,
    ).length !== 2 ||
    events.filter(
      (event, index) => index > idle && event.kind === 'track-started',
    ).length !== 1
  )
    failures.push('capture-not-reacquired');
  return { passed: failures.length === 0, failures };
}

export function parseLoopbackEndpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid endpoint');
  }
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('Endpoint must be an explicit loopback HTTP port');
  return url.origin;
}

export function verifyOfflineFixture(receipt, workerHash, label, hash) {
  if (
    receipt?.synthetic !== true ||
    receipt.worker_sha256 !== workerHash ||
    !Array.isArray(receipt.records)
  )
    return false;
  const cases = {
    prompt: ['prompt', 'prompt'],
    'content-1': ['content-1', null],
    'content-2': ['content-2-variation', null],
    finalize: ['finalize', null],
  };
  if (!Object.hasOwn(cases, label)) return false;
  const [fixture, expected] = cases[label];
  const row = receipt.records.find((record) => record.fixture === fixture);
  return (
    !!row &&
    row.exit === 0 &&
    row.sha256 === hash &&
    (label === 'finalize'
      ? ['end prompt', 'send prompt', 'send'].includes(row.actual_voice_command)
      : row.actual_voice_command === expected) &&
    (label !== 'content-1' ||
      [
        'stellar text pane',
        'native voice check',
        'voice pipeline complete',
      ].every((part) =>
        String(row.synthetic_transcript).toLowerCase().includes(part),
      )) &&
    (label !== 'content-2' ||
      [
        'speak the words',
        'voice pipeline complete',
        'only workspace tools',
        'do not read or change any files or settings',
      ].every((part) =>
        String(row.synthetic_transcript).toLowerCase().includes(part),
      ))
  );
}

export function verifyOfflineControls(receipt, negativeHash) {
  if (!Array.isArray(receipt?.records)) return false;
  const negative = receipt.records.find(
    (row) => row.fixture === 'negative-and-prompt',
  );
  const cached = receipt.records.find(
    (row) => row.fixture === 'cached-content',
  );
  const silence = receipt.records.find((row) => row.fixture === 'silence');
  return (
    !!negative &&
    negative.exit === 0 &&
    negative.sha256 === negativeHash &&
    negative.actual_voice_command === null &&
    !!cached &&
    cached.exit === 0 &&
    cached.actual_voice_command === null &&
    !!silence &&
    silence.exit === 0 &&
    silence.actual_voice_command === null &&
    typeof silence.synthetic_transcript === 'string' &&
    !silence.synthetic_transcript.trim()
  );
}

/** Preserve each sanitized observation even if a subsequent page read fails. */
export async function waitForVoiceObservation(
  page,
  predicate,
  timeoutMs = 120000,
  observe = () => undefined,
) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = await page.evaluate(() =>
      window.__stellarVoiceQualification.snapshot(),
    );
    if (value && typeof value === 'object') observe(value);
    if (!value?.installed || value.overflow)
      throw new Error('Qualification observer unavailable');
    if (predicate(value)) return value;
    await new Promise((done) => setTimeout(done, 150));
  }
  throw new Error('Qualification stage timed out');
}
