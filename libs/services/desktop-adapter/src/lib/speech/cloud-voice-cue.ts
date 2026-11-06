import type { SpeechSnapshot } from '@stellar/desktop-contracts';

/** A local acknowledgment owns no assistant answer and never consumes model output. */
export class CloudVoiceCue {
  private readonly seen = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private active?: {
    id: string;
    epoch: string;
    revision: bigint;
    playbackObserved?: boolean;
    dispatched: boolean;
    complete: Promise<boolean>;
    finish: (stopped: boolean) => void;
    deadline?: ReturnType<typeof setTimeout>;
  };
  private stopping?: Promise<boolean>;

  constructor(
    private readonly ports: {
      enabled: () => boolean;
      state: () => SpeechSnapshot;
      speak: (
        text: string,
        id: string,
        current?: () => boolean,
      ) => Promise<SpeechSnapshot>;
      stop: () => Promise<unknown>;
      stage: (
        stage: 'acknowledgment_requested' | 'acknowledgment_playback_observed',
      ) => void;
    },
  ) {}

  schedule(turnId: string) {
    if (this.seen.has(turnId) || this.timer || this.active || this.stopping)
      return;
    if (this.seen.size >= 64)
      this.seen.delete(this.seen.values().next().value ?? '');
    this.seen.add(turnId);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const state = this.ports.state();
      if (!this.ports.enabled() || state.state !== 'idle') return;
      let finish: (stopped: boolean) => void = () => undefined;
      const complete = new Promise<boolean>((resolve) => {
        finish = resolve;
      });
      const ticket = {
        id: crypto.randomUUID(),
        epoch: state.epoch,
        revision: BigInt(state.revision),
        dispatched: false,
        complete,
        finish,
      };
      this.active = ticket;
      this.ports.stage('acknowledgment_requested');
      void this.ports
        .speak('Mm, let me check.', ticket.id, () => {
          const current = this.active === ticket && this.ports.enabled();
          if (current) ticket.dispatched = true;
          return current;
        })
        .then(
          (snapshot) => {
            if (this.active === ticket) this.observe(snapshot);
          },
          () => {
            if (this.active === ticket) this.clear();
          },
        );
    }, 700);
  }

  observe(snapshot: SpeechSnapshot) {
    const active = this.active;
    if (!active) return;
    if (snapshot.operation_id === active.id) active.dispatched = true;
    if (
      !active.playbackObserved &&
      snapshot.operation_id === active.id &&
      snapshot.state === 'speaking'
    ) {
      active.playbackObserved = true;
      this.ports.stage('acknowledgment_playback_observed');
    }
    if (
      snapshot.epoch !== active.epoch ||
      (snapshot.operation_id === active.id &&
        BigInt(snapshot.revision) > active.revision &&
        ['idle', 'unavailable'].includes(snapshot.state))
    )
      this.clear();
  }

  handoff(): Promise<boolean> {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.stopping) return this.stopping;
    const active = this.active;
    if (!active) return Promise.resolve(true);
    if (!active.dispatched) {
      this.clear();
      return Promise.resolve(true);
    }
    active.deadline ??= setTimeout(() => {
      void this.cancel();
    }, 5000);
    return active.complete;
  }

  cancel(): Promise<boolean> {
    const active = this.active;
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!active) return this.stopping ?? Promise.resolve(true);
    clearTimeout(active.deadline);
    this.active = undefined;
    if (!active.dispatched) {
      active.finish(true);
      return Promise.resolve(true);
    }
    const stopping = this.ports.stop().then(
      () => true,
      () => false,
    );
    this.stopping = stopping;
    void stopping.then((stopped) => {
      active.finish(stopped);
      if (this.stopping === stopping) this.stopping = undefined;
    });
    return stopping;
  }

  /** The conversation's existing invalidation owns the corresponding native stop. */
  clear() {
    clearTimeout(this.timer);
    this.timer = undefined;
    clearTimeout(this.active?.deadline);
    this.active?.finish(true);
    this.active = undefined;
  }
}
