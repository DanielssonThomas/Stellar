import { describe, expect, it } from 'vitest';
import { SpeechActivity } from './speech-activity';
const calibration = {
  calibrating: false,
  active: false,
  level: 0,
  peakLevel: 0,
  durationMs: 0,
  noiseFloor: 0.0005,
  clipped: false,
};
const pcm = (level: number) =>
  new Int16Array(640).fill(Math.round(level * 32768));

describe('speech activity using shared microphone calibration', () => {
  it('admits quiet sustained speech while retaining a natural-pause hangover', () => {
    const gate = new SpeechActivity();
    expect(gate.push(pcm(0.006), calibration).active).toBe(false);
    gate.push(pcm(0.006), calibration);
    expect(gate.push(pcm(0.006), calibration).active).toBe(true);
    for (let i = 0; i < 15; i++)
      expect(gate.push(pcm(0), calibration).active).toBe(true);
    expect(gate.push(pcm(0), calibration).active).toBe(false);
  });
  it('rejects isolated impulses and noise below the calibrated onset ratio', () => {
    const gate = new SpeechActivity();
    expect(gate.push(pcm(0.1), calibration).active).toBe(false);
    for (let i = 0; i < 40; i++)
      expect(gate.push(pcm(0.0005), calibration).active).toBe(false);
    gate.reset();
    for (let i = 0; i < 40; i++)
      expect(
        gate.push(pcm(0.009), { ...calibration, noiseFloor: 0.004 }).active,
      ).toBe(false);
  });
  it('clears pending speech on capture reset and waits for the shared calibration', () => {
    const gate = new SpeechActivity();
    for (let i = 0; i < 8; i++) gate.push(pcm(0.006), calibration);
    gate.reset();
    expect(gate.push(pcm(0), calibration).active).toBe(false);
    expect(
      gate.push(pcm(0.1), { ...calibration, calibrating: true }).calibrating,
    ).toBe(true);
    expect(gate.push(pcm(0.006), calibration).active).toBe(false);
  });
});
