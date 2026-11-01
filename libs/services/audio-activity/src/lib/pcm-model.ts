export interface PcmChunk {
  readonly sampleRate: 16000;
  readonly sequence: number;
  readonly samples: Int16Array;
}

export type PcmEvent =
  | { readonly type: 'chunk'; readonly chunk: PcmChunk }
  | { readonly type: 'reset' | 'unavailable' };

export function validPcmChunk(value: unknown): value is PcmChunk {
  if (!value || typeof value !== 'object') return false;
  const chunk = value as Partial<PcmChunk>;
  return (
    chunk.sampleRate === 16000 &&
    Number.isSafeInteger(chunk.sequence) &&
    (chunk.sequence ?? -1) >= 0 &&
    chunk.samples instanceof Int16Array &&
    chunk.samples.length > 0 &&
    chunk.samples.length <= 640
  );
}
