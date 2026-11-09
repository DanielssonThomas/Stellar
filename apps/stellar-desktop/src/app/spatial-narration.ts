import type { SpeechSnapshot } from '@stellar/desktop-contracts';
import type {
  SpatialAction,
  SpatialSegment,
} from '@stellar/desktop-interaction';

export type SpatialNarrationMode =
  | 'idle'
  | 'preparing'
  | 'speaking'
  | 'reading'
  | 'paused';

type Reading = {
  readonly segment: SpatialSegment;
  remaining: number;
  deadline: number;
};

export function readingTime(text: string): number {
  const words = text.trim().split(/\s+/u).length;
  return Math.max(3200, words * 290, Array.from(text).length * 42) + 450;
}

type Playback = {
  readonly segment: SpatialSegment;
  readonly id: string;
  readonly epoch: string;
  readonly revision: bigint;
  acknowledged: boolean;
  started: boolean;
};

interface NarrationPort {
  readonly initialize: () => Promise<void>;
  readonly read: () => SpeechSnapshot;
  readonly speak: (text: string, id: string) => Promise<SpeechSnapshot>;
  readonly stop: () => Promise<unknown>;
  readonly id: () => string;
  readonly apply: (actions: readonly SpatialAction[]) => void;
  readonly record: (text: string) => void;
  readonly view: (mode: SpatialNarrationMode, caption: string) => void;
}

export class SpatialNarration {
  private readonly pending: SpatialSegment[] = [];
  private readonly waiters = new Set<() => void>();
  private active?: Playback;
  private initializing = false;
  private stopping?: Promise<unknown>;
  private generation = 0;
  private readAlong = false;
  private paused = false;
  private reading?: Reading;
  private readTimer?: ReturnType<typeof setTimeout>;
  private caption = '';

  constructor(private readonly port: NarrationPort) {}

  canAppend(count: number) {
    return (
      this.pending.length + (this.active || this.reading ? 1 : 0) + count <= 24
    );
  }

  append(segments: readonly SpatialSegment[]) {
    this.pending.push(...segments);
    this.pump();
  }

  ownsSpeech(snapshot: SpeechSnapshot): boolean {
    return (
      !!this.stopping ||
      (!!this.active &&
        snapshot.epoch === this.active.epoch &&
        (snapshot.operation_id === this.active.id || snapshot.state === 'idle'))
    );
  }

  whenQuiet(): Promise<void> {
    if (
      !this.stopping &&
      (this.readAlong || (!this.active && !this.pending.length))
    )
      return Promise.resolve();
    return new Promise((resolve) => this.waiters.add(resolve));
  }

  observe(snapshot: SpeechSnapshot) {
    const active = this.active;
    if (!active) {
      this.pump();
      return;
    }
    if (snapshot.epoch !== active.epoch) {
      this.cancel();
      return;
    }
    if (snapshot.state === 'unavailable') {
      this.fallback(active);
      return;
    }
    if (BigInt(snapshot.revision) <= active.revision) return;
    if (snapshot.state === 'speaking' && snapshot.operation_id === active.id) {
      this.start(active);
      return;
    }
    if (snapshot.state === 'idle' && (active.started || active.acknowledged)) {
      this.start(active);
      if (this.active !== active) return;
      this.active = undefined;
      this.port.apply(active.segment.after ?? []);
      this.pump();
    } else if (
      active.acknowledged &&
      snapshot.operation_id &&
      snapshot.operation_id !== active.id
    ) {
      this.fallback(active);
    }
  }

  toggleReadAlong() {
    if (!this.readAlong || (!this.reading && !this.pending.length)) return;
    this.paused = !this.paused;
    if (this.paused && this.reading && this.readTimer !== undefined) {
      this.reading.remaining = Math.max(
        0,
        this.reading.deadline - performance.now(),
      );
      this.clearReadTimer();
    }
    this.pump();
  }

  next() {
    if (!this.readAlong || (!this.reading && !this.pending.length)) return;
    this.paused = true;
    if (this.reading) this.completeReading(this.reading, true);
    else this.beginReading();
  }

  cancel() {
    this.generation++;
    this.initializing = false;
    this.pending.length = 0;
    this.clearReadTimer();
    this.readAlong = false;
    this.paused = false;
    this.reading = undefined;
    this.caption = '';
    const active = this.active;
    this.active = undefined;
    const snapshot = this.port.read();
    if (
      active &&
      snapshot.epoch === active.epoch &&
      (!snapshot.operation_id || snapshot.operation_id === active.id)
    ) {
      this.stopping = this.port
        .stop()
        .catch(() => undefined)
        .finally(() => {
          this.stopping = undefined;
          this.pump();
        });
    }
    this.publish('idle');
  }

  private start(active: Playback) {
    if (active.started) return;
    active.started = true;
    this.caption = active.segment.text;
    this.port.record(this.caption);
    this.port.apply(active.segment.actions);
    if (this.active === active) this.publish('speaking');
  }

  private fallback(active?: Playback) {
    if (active?.started) {
      this.reading = {
        segment: active.segment,
        remaining: readingTime(active.segment.text),
        deadline: 0,
      };
    } else if (active) {
      this.pending.unshift(active.segment);
    }
    this.active = undefined;
    this.readAlong = true;
    this.pump();
  }

  private pump() {
    if (this.active || this.initializing || this.stopping) return;
    if (this.readAlong && (this.reading || this.pending.length)) {
      if (!this.reading && !this.paused) this.beginReading();
      else this.scheduleReading();
      return;
    }
    if (!this.pending.length) {
      this.publish('idle');
      return;
    }
    const snapshot = this.port.read();
    if (
      ['collecting', 'synthesizing', 'speaking', 'transcribing'].includes(
        snapshot.state,
      )
    ) {
      this.publish('preparing');
      return;
    }
    this.initializing = true;
    this.publish('preparing');
    const generation = this.generation;
    void this.port
      .initialize()
      .then(() => {
        if (generation !== this.generation) return;
        this.initializing = false;
        const before = this.port.read();
        if (before.state === 'unavailable') {
          this.fallback();
          return;
        }
        if (
          ['collecting', 'synthesizing', 'speaking', 'transcribing'].includes(
            before.state,
          )
        )
          return;
        const segment = this.pending.shift();
        if (!segment) return;
        const active: Playback = {
          segment,
          id: this.port.id(),
          epoch: before.epoch,
          revision: BigInt(before.revision),
          acknowledged: false,
          started: false,
        };
        this.active = active;
        void this.port
          .speak(segment.text, active.id)
          .then((reply) => {
            if (this.active !== active) return;
            active.acknowledged = true;
            if (
              reply.state === 'idle' &&
              BigInt(reply.revision) <= active.revision
            ) {
              this.fallback(active);
              return;
            }
            this.observe(reply);
          })
          .catch(() => {
            if (this.active === active) this.fallback(active);
          });
      })
      .catch(() => {
        if (generation !== this.generation) return;
        this.initializing = false;
        this.fallback();
      });
  }

  private beginReading() {
    const segment = this.pending.shift();
    if (!segment) {
      this.publish('idle');
      return;
    }
    const reading: Reading = {
      segment,
      remaining: readingTime(segment.text),
      deadline: 0,
    };
    this.reading = reading;
    this.caption = segment.text;
    this.port.record(this.caption);
    this.port.apply(segment.actions);
    if (this.reading === reading) this.scheduleReading();
  }

  private scheduleReading() {
    const reading = this.reading;
    this.publish(this.paused ? 'paused' : 'reading');
    if (!reading || this.paused || this.readTimer !== undefined) return;
    reading.deadline = performance.now() + reading.remaining;
    this.readTimer = setTimeout(
      () => this.completeReading(reading),
      reading.remaining,
    );
  }

  private completeReading(reading: Reading, step = false) {
    if (this.reading !== reading) return;
    this.clearReadTimer();
    this.reading = undefined;
    const generation = this.generation;
    this.port.apply(reading.segment.after ?? []);
    if (this.generation !== generation) return;
    if (step) this.beginReading();
    else this.pump();
  }

  private clearReadTimer() {
    clearTimeout(this.readTimer);
    this.readTimer = undefined;
  }

  private publish(mode: SpatialNarrationMode) {
    this.port.view(mode, this.caption);
    if (!this.stopping && (mode === 'idle' || this.readAlong)) {
      for (const resolve of this.waiters) resolve();
      this.waiters.clear();
    }
  }
}
