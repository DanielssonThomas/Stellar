export interface AudioFrame {
  readonly timestampMs: number;
  readonly rms: number;
  readonly peak: number;
  readonly clipped: boolean;
}

export type AudioStatus =
  | 'idle'
  | 'requesting'
  | 'capturing'
  | 'suspended'
  | 'denied'
  | 'missing'
  | 'disconnected'
  | 'muted'
  | 'unavailable';

export interface AudioSink {
  readonly frame: (frame: AudioFrame) => void;
  readonly status: (status: AudioStatus) => void;
}

export interface AudioSource {
  start(sink: AudioSink, deviceId?: string): Promise<void>;
  stop(): Promise<void>;
}

export interface ActivitySnapshot {
  readonly calibrating: boolean;
  readonly active: boolean;
  readonly level: number;
  readonly peakLevel: number;
  readonly durationMs: number;
  readonly noiseFloor: number;
  readonly clipped: boolean;
}

export interface DetectorConfig {
  readonly calibrationMs: number;
  readonly minActiveMs: number;
  readonly hangoverMs: number;
  readonly maxGapMs: number;
  readonly minimumOn: number;
  readonly minimumOff: number;
  readonly onRatio: number;
  readonly offRatio: number;
}

export const DEFAULT_DETECTOR_CONFIG: Readonly<DetectorConfig> = Object.freeze({
  calibrationMs: 600,
  minActiveMs: 120,
  hangoverMs: 600,
  maxGapMs: 100,
  minimumOn: 0.015,
  minimumOff: 0.008,
  onRatio: 3,
  offRatio: 1.8,
});
