import { describe, expect, it } from 'vitest';
import { createUtteranceAssembler } from './utterance-assembler';
import type { PcmChunk } from './pcm-model';
import { ActivityDetector } from './activity-detector';

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
  it('configures ordinary silence independently and retains a pending onset at its boundary', () => {
    const assembler = createUtteranceAssembler({
      silenceMs: 800,
      draftSilenceMs: 540,
    });
    let sequence = 0;
    const push = (active: boolean, starting = false) =>
      assembler.push(
        {
          sampleRate: 16000,
          sequence: sequence++,
          samples: new Int16Array(640).fill(active ? 7 : 0),
        },
        { active, starting, calibrating: false },
      );
    for (let i = 0; i < 5; i++) push(true);
    for (let i = 0; i < 19; i++) expect(push(false)).toBeNull();
    expect(push(false, true)).toBeNull();
    for (let i = 0; i < 19; i++) expect(push(false)).toBeNull();
    expect(push(false)).not.toBeNull();
    for (const value of [0, 239, 3001, NaN, Infinity])
      expect(() => createUtteranceAssembler({ silenceMs: value })).toThrow();
  });
  it('keeps a detector-pending onset in the same draft across the quiet boundary', () => {
    const detector = new ActivityDetector();
    const assembler = createUtteranceAssembler();
    const outputs: Int16Array[] = [];
    let sequence = 0;
    let previous = detector.snapshot();
    const feedFrame = (rms: number, value: number) => {
      const frame = {
        timestampMs: sequence * 40,
        rms,
        peak: rms,
        clipped: false,
      };
      const activity = detector.push(frame);
      const output = assembler.push(
        {
          sampleRate: 16000,
          sequence: sequence++,
          samples: new Int16Array(640).fill(value),
        },
        { ...previous, draft: true },
      );
      previous = activity;
      if (output) outputs.push(output);
    };
    for (let i = 0; i < 18; i++) feedFrame(0.001, 0);
    for (let i = 0; i < 15; i++) feedFrame(0.1, 111);
    for (let i = 0; i < 26; i++) feedFrame(0.001, 0);
    for (let i = 0; i < 4; i++) feedFrame(0.1, 222);
    expect(outputs).toHaveLength(0);
    for (let i = 0; i < 10; i++) feedFrame(0.1, 222);
    for (let i = 0; i < 40; i++) feedFrame(0.001, 0);
    expect(outputs).toHaveLength(1);
    expect(outputs[0].some((sample) => sample === 111)).toBe(true);
    expect(outputs[0].some((sample) => sample === 222)).toBe(true);
  });
  it('retains the remainder of a non-aligned chunk across a draft cap', () => {
    const assembler = createUtteranceAssembler();
    const gate = { active: true, calibrating: false, draft: true };
    let sequence = 0;
    const push = (length: number, value: number) =>
      assembler.push(
        {
          sampleRate: 16000,
          sequence: sequence++,
          samples: new Int16Array(length).fill(value),
        },
        gate,
      );
    for (let i = 0; i < 499; i++) push(640, 1);
    push(540, 1);
    const capped = push(640, 2);
    expect(capped).toHaveLength(320000);
    expect(capped?.slice(-100).every((sample) => sample === 2)).toBe(true);
    for (let i = 0; i < 5; i++) push(640, 3);
    const preview = assembler.snapshot();
    expect(preview).toHaveLength(3740);
    expect(preview?.slice(0, 540).every((sample) => sample === 2)).toBe(true);
  });
  it('continues collecting draft audio across the 20-second cap without requiring silence', () => {
    const assembler = createUtteranceAssembler();
    const output: Int16Array[] = [];
    for (let sequence = 0; sequence < 505; sequence++) {
      const final = assembler.push(
        {
          sampleRate: 16000,
          sequence,
          samples: new Int16Array(640).fill(sequence < 500 ? 1 : 2),
        },
        { active: true, calibrating: false, draft: true },
      );
      if (final) output.push(final);
    }
    expect(output).toHaveLength(1);
    expect(output[0]).toHaveLength(320000);
    expect(assembler.snapshot()?.every((sample) => sample === 2)).toBe(true);
    expect(assembler.snapshot()).toHaveLength(3200);
  });

  it('retains a short final fragment after a cap instead of dropping it as noise', () => {
    const assembler = createUtteranceAssembler();
    let output: Int16Array | null = null;
    for (let sequence = 0; sequence < 515; sequence++) {
      const result = assembler.push(
        {
          sampleRate: 16000,
          sequence,
          samples: new Int16Array(640).fill(sequence === 500 ? 9 : 1),
        },
        { active: sequence <= 500, calibrating: false, draft: true },
      );
      if (sequence > 500 && result) output = result;
    }
    expect(output).not.toBeNull();
    expect(output?.[0]).toBe(9);
  });
  it('ends an active draft after roughly 560ms quiet, preserving the ordinary 1400ms tail', () => {
    const assembler = createUtteranceAssembler();
    let result: Int16Array | null = null;
    for (let sequence = 0; sequence < 19; sequence++) {
      result = assembler.push(
        { sampleRate: 16000, sequence, samples: new Int16Array(640).fill(7) },
        { active: sequence < 5, calibrating: false, draft: true },
      );
      if (sequence < 18) expect(result).toBeNull();
    }
    expect(result).toHaveLength(5 * 640 + 14 * 640);
  });
  it('copies an in-progress utterance without altering final output and resets its retained state', () => {
    const { feed, assembler } = fixture();
    feed(5, true, 7);
    const preview = assembler.snapshot();
    expect(preview).toHaveLength(3200);
    preview?.fill(0);
    feed(5, true, 8);
    const [final] = feed(35, false, 0);
    expect(final[0]).toBe(7);
    expect(final[3200]).toBe(8);
    expect(assembler.snapshot()).toBeNull();
  });
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
