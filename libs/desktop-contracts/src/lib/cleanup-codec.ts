import type { CleanupReply } from '../generated';
import {
  boundedString,
  DesktopContractError,
  record,
  version,
} from './wire-validation';

export function decodeCleanupReply(value: unknown): CleanupReply {
  const reply = record(value, ['version', 'text']);
  version(reply['version']);
  const text = reply['text'];
  if (text !== null && typeof text !== 'string')
    throw new DesktopContractError('malformed');
  return { version: 1, text: text === null ? null : boundedString(text, 8192) };
}
