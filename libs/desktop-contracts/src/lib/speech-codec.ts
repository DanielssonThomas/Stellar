import type {
  SpeechError,
  SpeechRequest,
  SpeechDuckingRequest,
  SpeechStopRequest,
  SpeechSnapshot,
  SpeechSpeakRequest,
  SpeechState,
  SpeechTranscribeRequest,
  SpeechTranscript,
  SpeechTiming,
  SpeechTimingStage,
} from '../generated';
import {
  boundedString,
  DesktopContractError,
  record,
  sequence,
  version,
} from './wire-validation';

const states: Record<SpeechState, true> = {
  idle: true,
  collecting: true,
  transcribing: true,
  synthesizing: true,
  speaking: true,
  unavailable: true,
};
const errors: Record<SpeechError, true> = {
  malformed_request: true,
  unsupported_version: true,
  busy: true,
  unavailable: true,
  model_missing: true,
  timeout: true,
  cancelled: true,
  protocol: true,
};
const timingStages: Record<SpeechTimingStage, true> = {
  synthesis_started: true,
  first_audio: true,
  synthesis_completed: true,
  playback_dispatched: true,
  playback_completed: true,
};

function decodeTimings(value: unknown): SpeechTiming[] {
  if (!Array.isArray(value) || value.length > 5)
    throw new DesktopContractError('malformed');
  const seen = new Set<SpeechTimingStage>();
  return value.map((item) => {
    const data = record(item, ['stage', 'elapsed_ms']);
    const stage = variant(data['stage'], timingStages);
    const elapsed = data['elapsed_ms'];
    if (
      seen.has(stage) ||
      typeof elapsed !== 'number' ||
      !Number.isInteger(elapsed) ||
      elapsed < 0 ||
      elapsed > 120000
    )
      throw new DesktopContractError('malformed');
    seen.add(stage);
    return { stage, elapsed_ms: elapsed };
  });
}

function variant<T extends string>(value: unknown, values: Record<T, true>): T {
  if (typeof value !== 'string' || !Object.hasOwn(values, value))
    throw new DesktopContractError('unknown-variant');
  return value as T;
}

function identifier(value: unknown): string {
  const result = boundedString(value, 36);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      result,
    )
  )
    throw new DesktopContractError('malformed');
  return result;
}

export function decodeSpeechRequest(value: unknown): SpeechRequest {
  const data = record(value, ['version']);
  return { version: version(data['version']) };
}

export function decodeSpeechDuckingRequest(
  value: unknown,
): SpeechDuckingRequest {
  const data = record(value, ['version', 'active']);
  if (typeof data['active'] !== 'boolean')
    throw new DesktopContractError('malformed');
  return { version: version(data['version']), active: data['active'] };
}

export function decodeSpeechStopRequest(value: unknown): SpeechStopRequest {
  const data = record(value, ['version', 'epoch']);
  return { version: version(data['version']), epoch: sequence(data['epoch']) };
}

export function decodeSpeechError(value: unknown): SpeechError {
  return variant(value, errors);
}

export function decodeSpeechTranscribeRequest(
  value: unknown,
): SpeechTranscribeRequest {
  const data = record(
    value,
    ['version', 'epoch', 'utterance_id', 'sample_rate_hz', 'pcm'],
    ['analyze_expression'],
  );
  const pcm = data['pcm'];
  const analyzeExpression = data['analyze_expression'];
  if (
    (analyzeExpression !== undefined &&
      typeof analyzeExpression !== 'boolean') ||
    data['sample_rate_hz'] !== 16000 ||
    !Array.isArray(pcm) ||
    pcm.length === 0 ||
    pcm.length > 320000 ||
    !Array.from(pcm).every(
      (sample) =>
        Number.isInteger(sample) && sample >= -32768 && sample <= 32767,
    )
  )
    throw new DesktopContractError('malformed');
  return {
    version: version(data['version']),
    epoch: sequence(data['epoch']),
    utterance_id: identifier(data['utterance_id']),
    sample_rate_hz: 16000,
    pcm: [...pcm],
    ...(analyzeExpression === undefined
      ? {}
      : { analyze_expression: analyzeExpression }),
  };
}

export function decodeSpeechTranscript(value: unknown): SpeechTranscript {
  const data = record(value, ['version', 'utterance_id', 'text']);
  return {
    version: version(data['version']),
    utterance_id: identifier(data['utterance_id']),
    text: boundedString(data['text'], 8192),
  };
}

export function decodeSpeechSpeakRequest(value: unknown): SpeechSpeakRequest {
  const data = record(value, ['version', 'epoch', 'utterance_id', 'text']);
  const text = boundedString(data['text'], 4000);
  if (!text.trim()) throw new DesktopContractError('malformed');
  return {
    version: version(data['version']),
    epoch: sequence(data['epoch']),
    utterance_id: identifier(data['utterance_id']),
    text,
  };
}

export function decodeSpeechSnapshot(value: unknown): SpeechSnapshot {
  const data = record(
    value,
    ['version', 'revision', 'epoch', 'operation_id', 'state', 'error'],
    ['timings'],
  );
  return {
    version: version(data['version']),
    revision: sequence(data['revision']),
    epoch: sequence(data['epoch']),
    operation_id:
      data['operation_id'] === null ? null : identifier(data['operation_id']),
    state: variant(data['state'], states),
    error: data['error'] === null ? null : decodeSpeechError(data['error']),
    ...(Object.hasOwn(data, 'timings')
      ? { timings: decodeTimings(data['timings']) }
      : {}),
  };
}
