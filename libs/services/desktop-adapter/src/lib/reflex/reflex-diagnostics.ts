import { reflexPercentiles } from './reflex-latency';

const stages = [
  'speech_end_observed',
  'vad_finalized',
  'stt_request',
  'stt_completed',
  'inference_start',
  'inference_complete',
  'action_dispatch',
  'action_complete',
  'hermes_submit',
  'hermes_admitted',
  'tts_request',
  'tts_synthesis_observed',
  'first_audio_observed',
  'playback_observed',
  'playback_completed',
];
const durations = [
  'utterance_settlement',
  'stt',
  'local_inference',
  'local_action',
  'transcript_to_action',
  'speech_end_to_action',
  'speech_end_to_first_audio_observed',
  'tts_to_first_audio_observed',
];
function numbers(value: unknown, keys: string[]) {
  const source =
    value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : {};
  return Object.fromEntries(
    keys
      .filter(
        (key) =>
          source[key] === null ||
          (typeof source[key] === 'number' &&
            Number.isFinite(source[key]) &&
            source[key] >= 0),
      )
      .map((key) => [key, source[key]]),
  );
}
export function captureReflexDiagnostics(state: {
  enabled: boolean;
  status: string;
  last_route: string;
  mode: string;
}) {
  const reflex = performance
    .getEntriesByName('stellar.reflex.latency')
    .slice(-128);
  const voice = performance
    .getEntriesByName('stellar.voice.latency')
    .slice(-64);
  const measurements = (entries: PerformanceEntry[]) =>
    entries.map((entry) => {
      const detail = (entry as PerformanceMeasure).detail ?? {};
      return {
        start_ms: entry.startTime,
        duration_ms: entry.duration,
        outcome: [
          'confirmed',
          'clarify',
          'rejected',
          'uncertain',
          'cancelled',
          'hermes',
          'unavailable',
          'completed',
          'interrupted',
        ].includes(detail.outcome)
          ? detail.outcome
          : 'unknown',
        stages_ms: numbers(detail.stages_ms, stages),
        durations_ms: numbers(detail.durations_ms, durations),
      };
    });
  return {
    schema_version: 1,
    captured_at: new Date().toISOString(),
    ...state,
    reflex_summary: reflexPercentiles(reflex),
    reflex: measurements(reflex),
    voice: measurements(voice),
  };
}
