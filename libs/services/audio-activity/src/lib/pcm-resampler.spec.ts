import { describe, expect, it } from 'vitest';
import { PcmResampler } from '../../worklet/pcm-resampler.js';

describe('continuous mono PCM resampling', () => {
  it.each([44100, 48000, 96000])(
    'preserves count and values across arbitrary %i Hz render boundaries',
    (rate) => {
      const render = (partition: number) => {
        const outputs: Int16Array[] = [];
        const resampler = new PcmResampler(rate, (chunk) =>
          outputs.push(chunk),
        );
        const samples = Float32Array.from(
          { length: rate },
          (_, index) => Math.sin(index / 30) * 0.6,
        );
        for (let offset = 0; offset < samples.length; offset += partition)
          expect(
            resampler.push([samples.subarray(offset, offset + partition)]),
          ).toBe(true);
        return Int16Array.from(outputs.flatMap((chunk) => [...chunk]));
      };
      const fine = render(128);
      expect(fine).toHaveLength(16000);
      expect(fine).toEqual(render(1973));
    },
  );

  it('downmixes channels, clamps PCM, rejects invalid frames and erases partial data on reset', () => {
    const outputs: Int16Array[] = [];
    const resampler = new PcmResampler(16000, (chunk) => outputs.push(chunk));
    resampler.push([
      new Float32Array(640).fill(1),
      new Float32Array(640).fill(-1),
    ]);
    expect([...outputs[0]]).toEqual(Array(640).fill(0));
    resampler.push([new Float32Array(640).fill(-2)]);
    expect(outputs[1][0]).toBe(-32768);
    resampler.push([new Float32Array(320).fill(0.5)]);
    resampler.reset();
    resampler.push([new Float32Array(640).fill(1)]);
    expect([...outputs[2]]).toEqual(Array(640).fill(32767));
    expect(resampler.push([Float32Array.of(NaN)])).toBe(false);
    expect(resampler.push([new Float32Array(1), new Float32Array(2)])).toBe(
      false,
    );
  });
});
