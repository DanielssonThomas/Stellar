import type { SpeechSnapshot } from '@stellar/desktop-contracts';

export class QuestionVoiceCue {
  private readonly seen = new Set<string>();
  private pending?: {
    epoch: string;
    revision: bigint;
    ready: Promise<void>;
    finish: () => void;
  };

  constructor(
    private readonly ports: {
      enabled: () => boolean;
      state: () => SpeechSnapshot;
      speak: (text: string, id: string) => Promise<SpeechSnapshot>;
      stop: () => Promise<unknown>;
    },
  ) {}

  notify(promptId: string) {
    if (this.seen.has(promptId)) return;
    if (this.seen.size >= 64)
      this.seen.delete(this.seen.values().next().value ?? '');
    this.seen.add(promptId);
    const before = this.ports.state();
    if (!this.ports.enabled() || before.state !== 'idle' || this.pending)
      return;
    let finish: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.pending = {
      epoch: before.epoch,
      revision: BigInt(before.revision),
      ready,
      finish,
    };
    void this.ports
      .speak('Could you check this out?', crypto.randomUUID())
      .then(
        (snapshot) => this.observe(snapshot),
        () => this.dispose(),
      );
  }

  wait(): Promise<void> {
    return this.pending?.ready ?? Promise.resolve();
  }

  observe(snapshot: SpeechSnapshot) {
    if (
      this.pending &&
      (snapshot.epoch !== this.pending.epoch ||
        (BigInt(snapshot.revision) > this.pending.revision &&
          ['idle', 'unavailable'].includes(snapshot.state)))
    )
      this.dispose();
  }

  dispose() {
    this.pending?.finish();
    this.pending = undefined;
  }

  cancel() {
    if (!this.pending) return;
    void this.ports
      .stop()
      .finally(() => this.dispose())
      .catch(() => undefined);
  }
}
