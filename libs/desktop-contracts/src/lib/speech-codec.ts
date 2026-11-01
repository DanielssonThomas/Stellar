import type {
  SpeechError,
  SpeechRequest,
  SpeechStopRequest,
  SpeechSnapshot,
  SpeechSpeakRequest,
  SpeechState,
  SpeechTranscribeRequest,
  SpeechTranscript,
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
  const data = record(value, [
    'version',
    'epoch',
    'utterance_id',
    'sample_rate_hz',
    'pcm',
  ]);
  const pcm = data['pcm'];
  if (
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
  const data = record(value, [
    'version',
    'revision',
    'epoch',
    'operation_id',
    'state',
    'error',
  ]);
  return {
    version: version(data['version']),
    revision: sequence(data['revision']),
    epoch: sequence(data['epoch']),
    operation_id:
      data['operation_id'] === null ? null : identifier(data['operation_id']),
    state: variant(data['state'], states),
    error: data['error'] === null ? null : decodeSpeechError(data['error']),
  };
}
