import { DEFAULT_DETECTOR_CONFIG } from './audio-model';
import type {
  ActivitySnapshot,
  AudioFrame,
  DetectorConfig,
} from './audio-model';

const clamp = (value: number): number => Math.min(1, Math.max(0, value));
const normalize = (value: number): number =>
  value === 0 ? 0 : clamp((20 * Math.log10(value) + 60) / 60);

export class ActivityDetector {
  private readonly config: DetectorConfig;
  private firstTimestamp: number | undefined;
  private lastTimestamp: number | undefined;
  private candidateSince: number | undefined;
  private silenceSince: number | undefined;
  private readonly calibrationSamples: number[] = [];
  private calibrationCursor = 0;
  private calibrating = true;
  private active = false;
  private level = 0;
  private peakLevel = 0;
  private durationMs = 0;
  private noiseFloor = 0;
  private clipped = false;

  constructor(config: Partial<DetectorConfig> = {}) {
    const merged = { ...DEFAULT_DETECTOR_CONFIG, ...config };
    for (const value of Object.values(merged)) {
      if (!Number.isFinite(value) || value < 0) {
        throw new RangeError(
          'Detector configuration must be finite and nonnegative',
        );
      }
    }
    if (
      merged.maxGapMs <= 0 ||
      merged.onRatio <= 0 ||
      merged.offRatio <= 0 ||
      merged.minimumOn <= merged.minimumOff ||
      merged.onRatio <= merged.offRatio
    ) {
      throw new RangeError(
        'Detector configuration requires positive timing and ordered thresholds',
      );
    }
    this.config = Object.freeze(merged);
  }

  reset(): void {
    this.firstTimestamp = undefined;
    this.lastTimestamp = undefined;
    this.candidateSince = undefined;
    this.silenceSince = undefined;
    this.calibrationSamples.length = 0;
    this.calibrationCursor = 0;
    this.calibrating = true;
    this.active = false;
    this.level = 0;
    this.peakLevel = 0;
    this.durationMs = 0;
    this.noiseFloor = 0;
    this.clipped = false;
  }

  snapshot(): ActivitySnapshot {
    return {
      calibrating: this.calibrating,
      active: this.active,
      level: this.level,
      peakLevel: this.peakLevel,
      durationMs: this.durationMs,
      noiseFloor: this.noiseFloor,
      clipped: this.clipped,
    };
  }

  pause(): void {
    this.active = false;
    this.level = 0;
    this.clipped = false;
    this.candidateSince = undefined;
    this.silenceSince = undefined;
    this.lastTimestamp = undefined;
    if (this.calibrating) {
      this.firstTimestamp = undefined;
      this.calibrationSamples.length = 0;
      this.calibrationCursor = 0;
    }
  }

  push(frame: AudioFrame): ActivitySnapshot {
    const timestamp = frame.timestampMs;
    if (
      !Number.isFinite(timestamp) ||
      !Number.isFinite(frame.rms) ||
      !Number.isFinite(frame.peak) ||
      (this.lastTimestamp !== undefined && timestamp <= this.lastTimestamp)
    ) {
      return this.snapshot();
    }
    const rms = clamp(frame.rms);
    const gap =
      this.lastTimestamp === undefined ? 0 : timestamp - this.lastTimestamp;
    if (gap > this.config.maxGapMs) {
      this.active = false;
      this.candidateSince = undefined;
      this.silenceSince = undefined;
      if (this.calibrating) {
        this.firstTimestamp = timestamp;
        this.calibrationSamples.length = 0;
        this.calibrationCursor = 0;
      }
    } else if (this.active) {
      this.durationMs += gap;
    }
    this.lastTimestamp = timestamp;
    this.firstTimestamp ??= timestamp;
    this.level = normalize(rms);
    this.peakLevel = Math.max(this.peakLevel, normalize(clamp(frame.peak)));
    this.clipped = frame.clipped;

    if (this.calibrating) {
      // A bounded rolling calibration window requires the caller to remain quiet.
      if (this.calibrationSamples.length < 256) {
        this.calibrationSamples.push(rms);
      } else {
        this.calibrationSamples[this.calibrationCursor] = rms;
        this.calibrationCursor = (this.calibrationCursor + 1) % 256;
      }
      if (timestamp - this.firstTimestamp < this.config.calibrationMs) {
        return this.snapshot();
      }
      const ordered = [...this.calibrationSamples].sort((a, b) => a - b);
      const middle = Math.floor(ordered.length / 2);
      this.noiseFloor =
        ordered.length % 2 === 0
          ? ((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2
          : (ordered[middle] ?? 0);
      this.calibrationSamples.length = 0;
      this.calibrating = false;
    }

    const on = Math.max(
      this.config.minimumOn,
      this.noiseFloor * this.config.onRatio,
    );
    const off = Math.max(
      this.config.minimumOff,
      this.noiseFloor * this.config.offRatio,
    );
    if (this.active) {
      if (rms <= off) {
        this.silenceSince ??= timestamp;
        if (timestamp - this.silenceSince >= this.config.hangoverMs) {
          this.active = false;
          this.silenceSince = undefined;
        }
      } else {
        this.silenceSince = undefined;
      }
    } else if (rms >= on) {
      this.candidateSince ??= timestamp;
      if (timestamp - this.candidateSince >= this.config.minActiveMs) {
        this.active = true;
        this.candidateSince = undefined;
      }
    } else {
      this.candidateSince = undefined;
    }
    return this.snapshot();
  }
}
