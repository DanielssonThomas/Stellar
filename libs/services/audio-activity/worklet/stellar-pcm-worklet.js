import { PcmResampler } from './pcm-resampler.js';

class StellarPcmProcessor extends globalThis.AudioWorkletProcessor {
  constructor() {
    super();
    this.sequence = 0;
    this.running = true;
    this.pending = new Set();
    this.resampler = new PcmResampler(globalThis.sampleRate, (samples) => {
      const sequence = this.sequence++;
      if (this.pending.size >= 4) {
        samples.fill(0);
        return;
      }
      this.pending.add(sequence);
      this.port.postMessage({ sampleRate: 16000, sequence, samples }, [
        samples.buffer,
      ]);
    });
    this.port.onmessage = ({ data }) => {
      if (data?.ack !== undefined) {
        this.pending.delete(data.ack);
        return;
      }
      if (data?.stop !== true) return;
      this.running = false;
      this.pending.clear();
      this.resampler.reset();
      this.port.close();
    };
  }

  process(inputs, outputs) {
    for (const output of outputs) for (const channel of output) channel.fill(0);
    if (!this.running) return false;
    if (!this.resampler.push(inputs[0] ?? [])) {
      this.resampler.reset();
      ++this.sequence;
    }
    return true;
  }
}

globalThis.registerProcessor('stellar-pcm', StellarPcmProcessor);
