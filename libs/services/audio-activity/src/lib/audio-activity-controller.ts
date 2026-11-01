import { ActivityDetector } from './activity-detector';
import type {
  ActivitySnapshot,
  AudioFrame,
  AudioSource,
  AudioStatus,
  DetectorConfig,
} from './audio-model';

export type AudioActivityState = Readonly<{
  status: AudioStatus;
  activity: ActivitySnapshot;
}>;

export class AudioActivityController {
  private readonly detector: ActivityDetector;
  private source: AudioSource | undefined;
  private generation = 0;
  private disposed = false;
  private lastPublished: number | undefined;
  private readonly bindings = new Set<() => void>();
  private current: AudioActivityState;

  constructor(
    private readonly onChange: (state: AudioActivityState) => void,
    config: Partial<DetectorConfig> = {},
  ) {
    this.detector = new ActivityDetector(config);
    this.current = this.freeze('idle', this.detector.snapshot());
  }

  snapshot(): AudioActivityState {
    return this.current;
  }

  async start(source: AudioSource, deviceId?: string): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.generation;
    const previous = this.source;
    this.source = source;
    void previous?.stop().catch(() => undefined);
    this.detector.reset();
    this.lastPublished = undefined;
    this.publish('requesting', this.detector.snapshot());
    try {
      await source.start(
        {
          frame: (frame) => {
            if (generation === this.generation) this.frame(frame);
          },
          status: (status) => {
            if (generation !== this.generation) return;
            if (status === 'suspended') {
              this.detector.pause();
              this.publish(status, this.detector.snapshot());
              return;
            }
            if (['capturing', 'requesting', 'suspended'].includes(status)) {
              this.publish(status, this.current.activity);
            } else {
              void this.stop(status);
            }
          },
        },
        deviceId,
      );
    } catch {
      if (generation === this.generation) await this.stop('unavailable');
    }
  }

  async stop(status: AudioStatus = 'idle'): Promise<void> {
    this.generation += 1;
    const source = this.source;
    this.source = undefined;
    this.publish(status, {
      ...this.detector.snapshot(),
      active: false,
      level: 0,
    });
    try {
      await source?.stop();
    } catch {
      // Adapter cleanup failure must not reactivate an invalidated session.
    }
  }

  suspend(): Promise<void> {
    return this.stop('suspended');
  }

  dispose(): Promise<void> {
    this.disposed = true;
    for (const unbind of this.bindings) unbind();
    return this.stop();
  }

  bindLifecycle(document: Document, window: Window): () => void {
    if (this.disposed) return () => undefined;
    const hidden = () => {
      if (document.hidden) void this.suspend();
    };
    const pagehide = () => void this.suspend();
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', pagehide);
    const unbind = () => {
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', pagehide);
      this.bindings.delete(unbind);
    };
    this.bindings.add(unbind);
    return unbind;
  }

  private frame(frame: AudioFrame): void {
    if (
      !Number.isFinite(frame.timestampMs) ||
      !Number.isFinite(frame.rms) ||
      !Number.isFinite(frame.peak)
    )
      return;
    const activity = this.detector.push(frame);
    const changed =
      activity.active !== this.current.activity.active ||
      activity.calibrating !== this.current.activity.calibrating;
    if (
      !changed &&
      this.lastPublished !== undefined &&
      frame.timestampMs - this.lastPublished < 50
    )
      return;
    this.lastPublished = frame.timestampMs;
    this.publish(this.current.status, activity);
  }

  private freeze(
    status: AudioStatus,
    activity: ActivitySnapshot,
  ): AudioActivityState {
    return Object.freeze({ status, activity: Object.freeze({ ...activity }) });
  }

  private publish(status: AudioStatus, activity: ActivitySnapshot): void {
    this.current = this.freeze(status, activity);
    this.onChange(this.current);
  }
}
