import type { SpeechSnapshot } from '@stellar/desktop-contracts';

type Entry = {
  text: string;
  id: string;
  current: () => boolean;
  resolve: (snapshot: SpeechSnapshot) => void;
  reject: (error: Error) => void;
};
type Active = {
  entry: Entry;
  generation: number;
  epoch: string;
  revision: bigint;
  returned: boolean;
  terminal?: SpeechSnapshot;
  deadline?: ReturnType<typeof setTimeout>;
};

/** One native speech owner; only its matching terminal event releases the next entry. */
export class SpeechPlaybackQueue {
  private pending: Entry[] = [];
  private active?: Active;
  private generation = 0;
  constructor(
    private readonly ports: {
      state: () => SpeechSnapshot;
      speak: (
        text: string,
        id: string,
        current: () => boolean,
      ) => Promise<SpeechSnapshot>;
      acknowledged?: (snapshot: SpeechSnapshot) => void;
      stop?: () => Promise<unknown>;
    },
  ) {}

  canAccept(texts: readonly string[]): boolean {
    const bytes = (text: string) => new TextEncoder().encode(text).length;
    return (
      this.pending.length + texts.length <= 16 &&
      texts.every((text) => bytes(text) <= 4000) &&
      [...this.pending.map((entry) => entry.text), ...texts].reduce(
        (sum, text) => sum + bytes(text),
        0,
      ) <= 32000
    );
  }

  play(
    text: string,
    id: string,
    current = () => true,
  ): Promise<SpeechSnapshot> {
    const bytes = new TextEncoder().encode(text).length;
    const queuedBytes = this.pending.reduce(
      (sum, item) => sum + new TextEncoder().encode(item.text).length,
      0,
    );
    if (
      bytes > 4000 ||
      this.pending.length >= 16 ||
      queuedBytes + bytes > 32000
    )
      return Promise.reject(new Error('Speech queue capacity exceeded'));
    return new Promise((resolve, reject) => {
      this.pending.push({ text, id, current, resolve, reject });
      this.pump();
    });
  }

  observe(snapshot: SpeechSnapshot) {
    const active = this.active;
    if (!active) {
      this.pump();
      return;
    }
    if (snapshot.epoch !== active.epoch) {
      this.reject(active, new Error('Speech epoch changed'));
      return;
    }
    if (
      snapshot.operation_id !== active.entry.id ||
      BigInt(snapshot.revision) <= active.revision
    )
      return;
    if (active.returned) this.ports.acknowledged?.(snapshot);
    if (snapshot.state === 'unavailable') {
      this.reject(active, new Error('Speech unavailable'));
      return;
    }
    if (snapshot.state === 'idle') active.terminal = snapshot;
    if (active.returned && active.terminal) {
      this.active = undefined;
      clearTimeout(active.deadline);
      active.entry.resolve(active.terminal);
      this.pump();
    }
  }

  owner() {
    return this.active
      ? { id: this.active.entry.id, generation: this.active.generation }
      : null;
  }
  busy() {
    return Boolean(this.active || this.pending.length);
  }

  clear() {
    ++this.generation;
    const entries = [
      ...this.pending,
      ...(this.active ? [this.active.entry] : []),
    ];
    this.pending = [];
    clearTimeout(this.active?.deadline);
    this.active = undefined;
    for (const entry of entries) entry.reject(new Error('Speech cancelled'));
  }

  private reject(active: Active, error: Error) {
    if (this.active !== active) return;
    clearTimeout(active.deadline);
    this.active = undefined;
    active.entry.reject(error);
    // A failed owner cannot establish that the native slot is free.
    for (const entry of this.pending.splice(0)) entry.reject(error);
  }

  private pump() {
    if (this.active) return;
    const before = this.ports.state();
    if (before.state === 'unavailable') {
      for (const entry of this.pending.splice(0))
        entry.reject(new Error('Speech unavailable'));
      return;
    }
    if (before.state !== 'idle') return;
    const entry = this.pending.shift();
    if (!entry) return;
    if (!entry.current()) {
      entry.reject(new Error('Speech ownership expired'));
      this.pump();
      return;
    }
    const active: Active = {
      entry,
      generation: this.generation,
      epoch: before.epoch,
      revision: BigInt(before.revision),
      returned: false,
    };
    this.active = active;
    // The native synthesis/playback operation has a 120-second deadline.
    active.deadline = setTimeout(() => {
      if (this.active !== active) return;
      this.reject(active, new Error('Speech completion was not observed'));
      void this.ports.stop?.().catch(() => undefined);
    }, 125000);
    void this.ports
      .speak(
        entry.text,
        entry.id,
        () =>
          this.active === active &&
          active.generation === this.generation &&
          entry.current(),
      )
      .then(
        (snapshot) => {
          if (this.active !== active) return;
          active.returned = true;
          this.observe(snapshot);
        },
        () => this.reject(active, new Error('Speech dispatch failed')),
      );
  }
}
