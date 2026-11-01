import { describe, expect, it } from 'vitest';
import { createUtteranceAssembler } from './utterance-assembler';
import type { PcmChunk } from './pcm-model';

function fixture() {
  const assembler = createUtteranceAssembler();
  let sequence = 0;
  const feed = (
    count: number,
    active: boolean,
    value = 100,
    calibrating = false,
  ) => {
    const outputs: Int16Array[] = [];
    for (let index = 0; index < count; index++) {
      const output = assembler.push(
        {
          sampleRate: 16000,
          sequence: sequence++,
          samples: new Int16Array(640).fill(value),
        },
        { active, calibrating },
      );
      if (output) outputs.push(output);
    }
    return outputs;
  };
  return { assembler, feed };
}

describe('bounded local utterance assembly', () => {
  it('includes rolling preroll, all contiguous voice, and 1400ms quiet without changing the detached output', () => {
    const { feed, assembler } = fixture();
    expect(feed(10, false, 1)).toEqual([]);
    expect(feed(5, true, 2)).toEqual([]);
    expect(feed(34, false, 3)).toEqual([]);
    const [output] = feed(1, false, 3);
    expect(output).toHaveLength(3840 + 3200 + 22400);
    expect([...output.slice(0, 3840)]).toEqual(Array(3840).fill(1));
    expect([...output.slice(3840, 7040)]).toEqual(Array(3200).fill(2));
    assembler.reset();
    expect(output[0]).toBe(1);
    expect(feed(5, true, 4)).toEqual([]);
    expect(feed(35, false, 5)[0][0]).toBe(4);
  });

  it('drops calibration/noise and short voice, including after reset', () => {
    const { feed, assembler } = fixture();
    expect(feed(600, true, 9, true)).toEqual([]);
    expect(feed(600, false)).toEqual([]);
    expect(feed(4, true)).toEqual([]);
    expect(feed(35, false)).toEqual([]);
    feed(8, true, 5);
    assembler.reset();
    expect(feed(35, false)).toEqual([]);
  });

  it('caps the whole recording at20seconds and waits for quiet before rearming', () => {
    const { feed } = fixture();
    feed(6, false);
    const outputs = feed(1000, true);
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toHaveLength(320000);
    expect(feed(1000, true)).toEqual([]);
    feed(1, false);
    feed(5, true);
    expect(feed(35, false)).toHaveLength(1);
  });

  it('discards retained samples across a gap, duplicate, bad rate or malformed chunk', () => {
    for (const invalid of [
      { sequence: 2 },
      { sequence: 100 },
      { sampleRate: 48000 },
      { samples: new Int16Array(641) },
      { samples: new Int16Array(0) },
      { samples: new Float32Array(640) },
      { sequence: NaN },
    ]) {
      const { assembler, feed } = fixture();
      feed(5, true, 77);
      assembler.push(
        {
          sampleRate: 16000,
          sequence: 5,
          samples: new Int16Array(640),
          ...invalid,
        } as PcmChunk,
        { active: false, calibrating: false },
      );
      expect(feed(40, false)).toEqual([]);
    }
  });
});
