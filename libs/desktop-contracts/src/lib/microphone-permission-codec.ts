import type { MicrophoneReviewReply } from '../generated';

export function decodeMicrophoneReviewReply(
  value: unknown,
): MicrophoneReviewReply {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid microphone review');
  const fields = value as Record<string, unknown>;
  if (
    Object.keys(fields).length !== 2 ||
    fields['version'] !== 1 ||
    (fields['outcome'] !== 'allowed' && fields['outcome'] !== 'cancelled')
  )
    throw new Error('Invalid microphone review');
  return value as MicrophoneReviewReply;
}
