import type {
  KeywordCommand,
  KeywordMode,
  KeywordReply,
  KeywordRequest,
} from '../generated';
import {
  boundedString,
  DesktopContractError,
  record,
  sequence,
  version,
} from './wire-validation';

const commands: Record<KeywordCommand, true> = {
  ivy: true,
  done: true,
  clear: true,
  prompt: true,
  'prompt cancel': true,
  'new session': true,
  'reload mcp': true,
};
const modes: Record<KeywordMode, true> = {
  passive: true,
  listening: true,
  composing: true,
};
function uint(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 0xffffffff
  )
    throw new DesktopContractError('malformed');
  return value;
}
export function decodeKeywordRequest(value: unknown): KeywordRequest {
  const data = record(value, [
    'version',
    'epoch',
    'stream_id',
    'sequence',
    'pcm',
    'threshold',
    'mode',
  ]);
  const stream = boundedString(data['stream_id'], 96);
  const pcm = data['pcm'];
  const threshold = data['threshold'];
  const mode = data['mode'];
  if (
    !/^[a-zA-Z0-9_:-]+$/.test(stream) ||
    !Array.isArray(pcm) ||
    !pcm.length ||
    pcm.length > 640 ||
    !pcm.every((x) => Number.isInteger(x) && x >= -32768 && x <= 32767) ||
    typeof threshold !== 'number' ||
    !Number.isFinite(threshold) ||
    threshold < 0.001 ||
    threshold > 0.2 ||
    typeof mode !== 'string' ||
    !Object.hasOwn(modes, mode)
  )
    throw new DesktopContractError('malformed');
  return {
    version: version(data['version']),
    epoch: sequence(data['epoch']),
    stream_id: stream,
    sequence: uint(data['sequence']),
    pcm: [...pcm],
    threshold,
    mode: mode as KeywordMode,
  };
}
export function decodeKeywordReply(value: unknown): KeywordReply {
  const data = record(value, ['sequence', 'detection']);
  let detection: KeywordReply['detection'] = null;
  if (data['detection'] !== null) {
    const found = record(data['detection'], ['command', 'end_sample']);
    const command = found['command'];
    if (typeof command !== 'string' || !Object.hasOwn(commands, command))
      throw new DesktopContractError('unknown-variant');
    detection = {
      command: command as KeywordCommand,
      end_sample: uint(found['end_sample']),
    };
  }
  return { sequence: uint(data['sequence']), detection };
}
