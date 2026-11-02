/** Validate only observed, sanitized events; never infer physical microphone behavior. */
export function assessVoiceQualification(trace) {
  const failures = [];
  const events = trace?.events;
  if (!Array.isArray(events) || trace.overflow || !trace.installed)
    return { passed: false, failures: ['observer-unavailable'] };
  const calls = (kind, command) =>
    events.filter((event) => event.kind === kind && event.command === command);
  const recognition = calls('result', 'speech_transcribe');
  if (
    recognition.length !== 3 ||
    recognition.some((event) => !event.ok) ||
    recognition[0]?.recognized !== 'prompt' ||
    recognition[1]?.recognized !== 'content' ||
    !['end prompt', 'send prompt', 'send'].includes(
      recognition[2]?.recognized,
    ) ||
    !recognition[1]?.intent
  )
    failures.push('recognition-or-intent');
  const busy = events.filter(
    (event) =>
      event.kind === 'invoke' &&
      [
        'speech_transcribe',
        'cleanup_refine',
        'ivy_submit',
        'speech_speak',
      ].includes(event.command),
  );
  if (busy.some((event) => event.active !== 0))
    failures.push('capture-not-released');
  const cleanup = calls('result', 'cleanup_refine');
  if (
    cleanup.length !== 1 ||
    !cleanup[0].ok ||
    !cleanup[0].cleaned ||
    !recognition[2] ||
    cleanup[0].at < recognition[2].at
  )
    failures.push('cleanup-unconfirmed');
  const submit = calls('invoke', 'ivy_submit');
  if (
    submit.length !== 1 ||
    !submit[0].dissolved ||
    !submit[0].opacityZero ||
    !cleanup[0] ||
    submit[0].at < cleanup[0].at
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
    idle < 0
  )
    failures.push('playback-unconfirmed');
  if (
    trace.active !== 1 ||
    trace.acquisitions !== 4 ||
    events.filter(
      (event) => event.kind === 'track-stopped' && event.ended === true,
    ).length !== 3 ||
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
    content: ['owned-content', null],
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
    (label !== 'content' ||
      [
        'native voice check',
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
