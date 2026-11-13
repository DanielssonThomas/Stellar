import type {
  IvyBackgroundUpdate,
  SpeechSnapshot,
} from '@stellar/desktop-contracts';

interface Ports {
  available(): boolean;
  busy(): boolean;
  eligible?(): boolean;
  enabled(): boolean;
  state(): SpeechSnapshot;
  claim(id: string, request: string): Promise<boolean>;
  speak(
    text: string,
    id: string,
    current: () => boolean,
  ): Promise<SpeechSnapshot>;
  stop(id: string): Promise<unknown>;
  waitForQuestion(): Promise<void>;
  id(): string;
  changed(): void;
  failed(): void;
}

/** Speech claims are persisted before dispatch; uncertain playback is never retried. */
export class UpdateVoiceCue {
  private generation = 0;
  private pending?: Promise<void>;
  private readonly attempted = new Set<string>();
  private playing?: { epoch: string; revision: bigint; done: () => void };
  private disposed = false;
  private dispatching = false;
  private operation?: string;
  private update?: string;
  private offered = new Set<string>();
  private waiting?: () => void;

  constructor(private readonly ports: Ports) {}

  observe(updates: readonly IvyBackgroundUpdate[]) {
    if (this.disposed) return;
    this.offered = new Set(updates.map((item) => item.id));
    if (this.update && !this.offered.has(this.update)) this.cancel();
    if (!this.ports.available()) {
      this.cancel();
      return;
    }
    const state = this.ports.state();
    if (this.waiting && !this.ports.busy() && state.state === 'idle') {
      const ready = this.waiting;
      this.waiting = undefined;
      ready();
    }
    if (
      this.playing &&
      (state.epoch !== this.playing.epoch ||
        (BigInt(state.revision) >= this.playing.revision &&
          ['idle', 'unavailable'].includes(state.state)))
    ) {
      const done = this.playing.done;
      this.playing = undefined;
      if (state.state === 'unavailable') this.ports.failed();
      done();
    }
    if (
      this.pending ||
      this.ports.busy() ||
      !['idle', 'unavailable'].includes(state.state)
    )
      return;
    for (const id of this.attempted)
      if (!updates.some((u) => u.id === id)) this.attempted.delete(id);
    const next = updates.find(
      (u) => u.speech_claim === null && !this.attempted.has(u.id),
    );
    if (!next) return;
    this.attempted.add(next.id);
    this.update = next.id;
    const generation = this.generation;
    const pending = this.run(next, generation);
    this.pending = pending;
    void pending.finally(() => {
      if (this.pending === pending) this.pending = undefined;
      if (!this.disposed) this.ports.changed();
    });
  }

  wait(): Promise<void> {
    return this.dispatching
      ? (this.pending ?? Promise.resolve())
      : Promise.resolve();
  }

  private current(generation: number) {
    return (
      !this.disposed &&
      generation === this.generation &&
      this.ports.available() &&
      this.update !== undefined &&
      this.offered.has(this.update)
    );
  }

  private async run(update: IvyBackgroundUpdate, generation: number) {
    try {
      await this.ports.waitForQuestion();
      if (!this.current(generation) || this.ports.busy()) {
        this.attempted.delete(update.id);
        return;
      }
      const claimed = await this.ports.claim(update.id, this.ports.id());
      if (!claimed || !this.current(generation) || !this.ports.enabled())
        return;
      if (this.ports.state().state === 'unavailable') {
        this.ports.failed();
        return;
      }
      while (this.current(generation) && this.ports.enabled()) {
        await this.ports.waitForQuestion();
        if (!this.current(generation) || !this.ports.enabled()) return;
        if (this.ports.state().state === 'unavailable') {
          this.ports.failed();
          return;
        }
        if (!this.ports.busy() && this.ports.state().state === 'idle') break;
        await new Promise<void>((ready) => {
          this.waiting = ready;
        });
      }
      if (!this.current(generation) || !this.ports.enabled()) return;
      const text =
        new TextEncoder().encode(update.text).length <= 4000
          ? update.text
          : "I have an update for you. It's available in the conversation.";
      this.dispatching = true;
      this.operation = this.ports.id();
      const snapshot = await this.ports.speak(
        text,
        this.operation,
        () =>
          this.current(generation) &&
          this.ports.enabled() &&
          (this.ports.eligible?.() ?? true),
      );
      if (!this.current(generation)) return;
      if (snapshot.state === 'unavailable') {
        this.ports.failed();
        return;
      }
      const observed = this.ports.state();
      if (
        snapshot.state === 'idle' ||
        (observed.state === 'idle' &&
          BigInt(observed.revision) >= BigInt(snapshot.revision))
      )
        return;
      await new Promise<void>((done) => {
        this.playing = {
          epoch: snapshot.epoch,
          revision: BigInt(snapshot.revision),
          done,
        };
      });
    } catch {
      if (this.current(generation)) this.ports.failed();
    } finally {
      this.dispatching = false;
      this.operation = undefined;
    }
  }

  cancel() {
    ++this.generation;
    const playing = this.playing;
    this.playing = undefined;
    const waiting = this.waiting;
    this.waiting = undefined;
    waiting?.();
    playing?.done();
    if (this.dispatching && this.operation) {
      void this.ports.stop(this.operation).catch(() => this.ports.failed());
    }
  }

  dispose() {
    this.cancel();
    this.disposed = true;
  }
}
