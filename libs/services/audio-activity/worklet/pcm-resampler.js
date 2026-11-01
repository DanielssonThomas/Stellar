export class PcmResampler {
  constructor(sampleRate, emit) {
    if (
      !Number.isFinite(sampleRate) ||
      sampleRate < 8000 ||
      sampleRate > 192000
    )
      throw new RangeError('Unsupported audio sample rate');
    this.ratio = sampleRate / 16000;
    this.emit = emit;
    this.buffer = new Int16Array(640);
    this.reset();
  }

  reset() {
    this.buffer.fill(0);
    this.offset = 0;
    this.weight = 0;
    this.sum = 0;
  }

  push(channels) {
    if (!channels.length || channels.length > 32) return false;
    const length = channels[0].length;
    if (!length || length > 4096 || channels.some((c) => c.length !== length))
      return false;
    for (let index = 0; index < length; index++) {
      let value = 0;
      for (const channel of channels) {
        if (!Number.isFinite(channel[index])) {
          this.reset();
          return false;
        }
        value += Math.max(-1, Math.min(1, channel[index])) / channels.length;
      }
      let remaining = 1;
      while (remaining > 1e-10) {
        const taken = Math.min(remaining, this.ratio - this.weight);
        this.sum += value * taken;
        this.weight += taken;
        remaining -= taken;
        if (this.weight + 1e-10 >= this.ratio) {
          const average = this.sum / this.ratio;
          this.buffer[this.offset++] = Math.round(
            average * (average < 0 ? 32768 : 32767),
          );
          this.sum = 0;
          this.weight = 0;
          if (this.offset === this.buffer.length) {
            const output = this.buffer;
            this.buffer = new Int16Array(640);
            this.offset = 0;
            this.emit(output);
          }
        }
      }
    }
    return true;
  }
}
