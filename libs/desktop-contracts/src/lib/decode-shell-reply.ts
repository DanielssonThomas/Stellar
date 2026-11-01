import type { ShellReply } from '../generated';

export function decodeShellReply(value: unknown): ShellReply {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Malformed desktop reply');
  const fields = value as Record<string, unknown>;
  if (
    Object.keys(fields).length !== 3 ||
    fields['version'] !== 1 ||
    fields['application'] !== 'stellar-desktop' ||
    fields['ready'] !== true
  )
    throw new Error('Incompatible desktop reply');
  return {
    version: fields['version'],
    application: fields['application'],
    ready: fields['ready'],
  };
}
