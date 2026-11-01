import { describe, expect, it } from 'vitest';
import { ActivityDetector } from './activity-detector';
import type { AudioFrame } from './audio-model';

const frame = (timestampMs: number, rms = 0, peak = rms): AudioFrame => ({
  timestampMs,
  rms,
  peak,
  clipped: peak >= 0.999,
});
const calibrated = () => {
  const detector = new ActivityDetector({ calibrationMs: 0 });
  detector.push(frame(0));
  return detector;
};

describe('amplitude activity detection', () => {
  it('calibrates a fixed quiet median and does not classify steady background noise as speech', () => {
    const detector = new ActivityDetector();
    for (let t = 0; t <= 600; t += 30) detector.push(frame(t, 0.01));
    expect(detector.snapshot()).toMatchObject({
      calibrating: false,
      noiseFloor: 0.01,
      active: false,
    });
    for (let t = 630; t < 5000; t += 30) detector.push(frame(t, 0.025));
    expect(detector.snapshot()).toMatchObject({
      noiseFloor: 0.01,
      active: false,
      durationMs: 0,
    });
  });

  it('requires minimum activity, holds a hysteresis band and ends after silence hangover', () => {
    const detector = calibrated();
    expect(detector.push(frame(30, 0.03)).active).toBe(false);
    detector.push(frame(90, 0.03));
    expect(detector.push(frame(150, 0.03)).active).toBe(true);
    expect(detector.push(frame(200, 0.01)).active).toBe(true);
    for (let t = 250; t < 850; t += 50)
      expect(detector.push(frame(t)).active).toBe(true);
    expect(detector.push(frame(850)).active).toBe(false);
    expect(detector.snapshot().durationMs).toBe(700);
    expect(detector.push(frame(900, 0.03)).active).toBe(false);
  });

  it('rejects brief impulses and resets the activation candidate when the level falls', () => {
    const detector = calibrated();
    for (let t = 30; t <= 3000; t += 30)
      detector.push(frame(t, t % 90 === 0 ? 1 : 0));
    expect(detector.snapshot()).toMatchObject({
      active: false,
      durationMs: 0,
      peakLevel: 1,
    });
  });

  it('does not count missing time or use a long missing interval as calibration evidence', () => {
    const detector = new ActivityDetector();
    detector.push(frame(0, 0.01));
    expect(detector.push(frame(10000, 0.01)).calibrating).toBe(true);
    for (let t = 10030; t <= 10600; t += 30) detector.push(frame(t, 0.01));
    expect(detector.snapshot().calibrating).toBe(false);
    const active = calibrated();
    for (let t = 30; t <= 180; t += 30) active.push(frame(t, 0.1));
    expect(active.snapshot().active).toBe(true);
    const before = active.snapshot().durationMs;
    expect(active.push(frame(10000, 0.1))).toMatchObject({
      active: false,
      durationMs: before,
    });
  });

  it('ignores nonfinite, backwards and duplicate samples without mutating state', () => {
    const detector = calibrated();
    detector.push(frame(30, 0.01));
    const before = detector.snapshot();
    for (const invalid of [
      frame(NaN),
      frame(Infinity),
      frame(60, NaN),
      frame(60, 0.1, Infinity),
      frame(-1, 1),
      frame(30, 1),
    ]) {
      expect(detector.push(invalid)).toEqual(before);
    }
  });

  it('clamps levels, reports clipping, handles digital silence and resets summaries', () => {
    const detector = calibrated();
    expect(detector.push(frame(30, 9, 10))).toMatchObject({
      level: 1,
      peakLevel: 1,
      clipped: true,
    });
    expect(detector.push(frame(60, -3, -2))).toMatchObject({
      level: 0,
      peakLevel: 1,
      clipped: false,
    });
    detector.reset();
    expect(detector.snapshot()).toMatchObject({
      calibrating: true,
      active: false,
      durationMs: 0,
      peakLevel: 0,
    });
  });

  it('keeps a noisy calibration honest instead of lowering thresholds to force activation', () => {
    const detector = new ActivityDetector({ calibrationMs: 0 });
    detector.push(frame(0, 0.8));
    for (let t = 30; t < 3000; t += 30) detector.push(frame(t, 1));
    expect(detector.snapshot()).toMatchObject({
      active: false,
      noiseFloor: 0.8,
      clipped: true,
    });
  });

  it('validates configuration and returns detached snapshots', () => {
    for (const config of [
      { maxGapMs: 0 },
      { hangoverMs: -1 },
      { minimumOn: 0.001 },
      { onRatio: 1 },
      { minActiveMs: NaN },
    ]) {
      expect(() => new ActivityDetector(config)).toThrow(RangeError);
    }
    const detector = calibrated();
    Object.assign(detector.snapshot(), { active: true, durationMs: Infinity });
    expect(detector.snapshot()).toMatchObject({ active: false, durationMs: 0 });
  });
});
