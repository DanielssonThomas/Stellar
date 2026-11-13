import type { IvyLifecycleLease } from '../generated';
import { boundedString, DesktopContractError, record } from './wire-validation';

export function decodeIvyLifecycleLease(value: unknown): IvyLifecycleLease {
  const row = record(value, ['operation', 'kind', 'text']);
  const operation = boundedString(row['operation'], 32);
  const text = boundedString(row['text'], 262144);
  if (!/^[a-f0-9]{32}$/.test(operation) || !text.trim())
    throw new DesktopContractError('malformed');
  if (row['kind'] !== 'render' && row['kind'] !== 'speech')
    throw new DesktopContractError('unknown-variant');
  return { operation, kind: row['kind'], text };
}
