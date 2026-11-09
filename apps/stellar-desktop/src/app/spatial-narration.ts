import type { SpeechSnapshot } from '@stellar/desktop-contracts';
import type {
  SpatialAction,
  SpatialSegment,
} from '@stellar/desktop-interaction';

export type SpatialNarrationMode = 'idle' | 'preparing' | 'speaking' | 'manual';

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
  readonly view: (mode: SpatialNarrationMode, caption: string) => void;
}

export class SpatialNarration {
  private readonly pending: SpatialSegment[] = [];
  private readonly waiters = new Set<() => void>();
  private active?: Playback;
  private initializing = false;
  private stopping?: Promise<unknown>;
  private generation = 0;
  private manual = false;
  private caption = '';

  constructor(private readonly port: NarrationPort) {}

  canAppend(count: number) {
    return this.pending.length + (this.active ? 1 : 0) + count <= 24;
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
      (this.manual || (!this.active && !this.pending.length))
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

  next() {
    if (!this.manual) return;
    const segment = this.pending.shift();
    if (!segment) return;
    const generation = this.generation;
    this.caption = segment.text;
    this.port.apply(segment.actions);
    if (this.generation !== generation) return;
    this.port.apply(segment.after ?? []);
    this.pump();
  }

  cancel() {
    this.generation++;
    this.initializing = false;
    this.pending.length = 0;
    this.manual = false;
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
    this.port.apply(active.segment.actions);
    if (this.active === active) this.publish('speaking');
  }

  private fallback(active?: Playback) {
    if (active && !active.started) this.pending.unshift(active.segment);
    this.active = undefined;
    this.manual = true;
    this.pump();
  }

  private pump() {
    if (this.active || this.initializing || this.stopping) return;
    if (!this.pending.length) {
      this.publish('idle');
      return;
    }
    if (this.manual) {
      this.publish('manual');
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

  private publish(mode: SpatialNarrationMode) {
    this.port.view(mode, this.caption);
    if (!this.stopping && (mode === 'idle' || mode === 'manual')) {
      for (const resolve of this.waiters) resolve();
      this.waiters.clear();
    }
  }
}
