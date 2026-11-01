export class PcmResampler {
  constructor(sampleRate: number, emit: (samples: Int16Array) => void);
  push(channels: readonly Float32Array[]): boolean;
  reset(): void;
}
