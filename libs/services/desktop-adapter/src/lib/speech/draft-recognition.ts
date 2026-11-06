import type { SpeechTranscript } from '@stellar/desktop-contracts';

type Work = {
  pcm: Int16Array;
  id: string;
  final: boolean;
  generation: number;
  revision: number;
  commandAllowed: boolean;
  wakeAllowed: boolean;
  purpose: 'draft' | 'wake';
};

/** Owns bounded speech snapshots until they are settled or erased. */
export class DraftRecognition {
  private generation = 0;
  private previewRevision = 0;
  private running?: Work;
  private readonly finals: Work[] = [];
  private preview?: Work;
  private stopping?: Promise<void>;

  constructor(
    private readonly collect: (
      pcm: Int16Array,
      id: string,
    ) => Promise<SpeechTranscript>,
    private readonly stop: () => Promise<unknown>,
    private readonly completed: (
      text: string,
      id: string,
      final: boolean,
      commandAllowed: boolean,
      wakeAllowed: boolean,
    ) => void | Promise<void>,
    private readonly failed: () => void,
    private readonly interruptPreviews = true,
    private readonly timing?: (
      stage: 'queued' | 'started' | 'completed',
    ) => void,
    private readonly waitForCollect?: () => Promise<void> | undefined,
  ) {}

  canPreview(): boolean {
    return (
      !this.running &&
      !this.stopping &&
      !this.preview &&
      this.finals.length === 0
    );
  }

  isBusy(): boolean {
    return Boolean(
      this.running || this.stopping || this.preview || this.finals.length,
    );
  }

  offer(
    pcm: Int16Array,
    id: string,
    final: boolean,
    commandAllowed = true,
    purpose: 'draft' | 'wake' = 'draft',
    wakeAllowed = commandAllowed,
  ): void {
    const work = {
      pcm,
      id,
      final,
      commandAllowed,
      wakeAllowed,
      purpose,
      generation: this.generation,
      revision: ++this.previewRevision,
    };
    if (final) {
      this.timing?.('queued');
      if (this.finals.length >= 3) {
        pcm.fill(0);
        this.reset();
        this.failed();
        return;
      }
      this.finals.push(work);
      this.preview?.pcm.fill(0);
      this.preview = undefined;
      // Let the first wake hit activate presence even when settlement queues a final.
      if (
        this.interruptPreviews &&
        this.running &&
        !this.running.final &&
        this.running.purpose !== 'wake'
      )
        this.interrupt();
    } else {
      this.preview?.pcm.fill(0);
      this.preview = work;
    }
    this.pump();
  }

  reset(): Promise<void> | undefined {
    ++this.generation;
    this.clearPending();
    if (this.running) this.interrupt();
    return this.stopping;
  }

  clearPending(): void {
    for (const work of this.finals.splice(0)) work.pcm.fill(0);
    this.preview?.pcm.fill(0);
    this.preview = undefined;
  }

  private interrupt(): void {
    if (this.stopping) return;
    const stopping = this.stop().then(() => undefined);
    this.stopping = stopping;
    const deadline = setTimeout(() => this.failed(), 5000);
    void stopping
      .catch(() => this.failed())
      .finally(() => {
        clearTimeout(deadline);
        if (this.stopping === stopping) this.stopping = undefined;
        this.pump();
      });
  }

  private pump(): void {
    if (this.running || this.stopping) return;
    const work = this.finals.shift() ?? this.preview;
    if (!work) return;
    if (this.preview === work) this.preview = undefined;
    this.running = work;
    const dispatch = () => {
      if (work.generation !== this.generation) return;
      if (work.final) this.timing?.('started');
      return this.collect(work.pcm, work.id);
    };
    const pending = this.waitForCollect?.();
    const request = pending ? pending.then(dispatch) : dispatch();
    void Promise.resolve(request)
      .then(async (result) => {
        if (!result) return;
        if (work.final && work.generation === this.generation)
          this.timing?.('completed');
        if (
          work.generation === this.generation &&
          result.utterance_id === work.id &&
          (work.final ||
            work.purpose === 'wake' ||
            (this.finals.length === 0 &&
              work.revision === this.previewRevision))
        )
          await this.completed(
            result.text,
            work.id,
            work.final,
            work.commandAllowed,
            work.wakeAllowed,
          );
      })
      .catch(() => {
        if (work.final && work.generation === this.generation) this.failed();
      })
      .finally(() => {
        work.pcm.fill(0);
        if (this.running === work) this.running = undefined;
        this.pump();
      });
  }
}
