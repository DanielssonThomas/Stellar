import type {
  KeywordDetection,
  KeywordMode,
  KeywordReply,
} from '@stellar/desktop-contracts';
import { validPcmChunk, type PcmChunk } from '@stellar/service-audio-activity';

export type KeywordPort = (
  pcm: Int16Array,
  stream: string,
  sequence: number,
  threshold: number,
  mode: KeywordMode,
) => Promise<KeywordReply>;
interface Buffered {
  chunk: PcmChunk;
  offset: number;
}

export class FastCommands {
  private generation = 0;
  private identity = '';
  private mode: KeywordMode = 'passive';
  private sequence: number | null = null;
  private offset = 0;
  private queue: { entry: Buffered; threshold: number; generation: number }[] =
    [];
  private tail: Buffered[] = [];
  private running = false;
  constructor(
    private readonly port: KeywordPort,
    private readonly id: () => string,
    private readonly detected: (
      detection: KeywordDetection,
      tail: PcmChunk[],
    ) => void,
    private readonly failed: () => void,
  ) {}

  reset() {
    ++this.generation;
    this.identity = this.id();
    this.sequence = null;
    this.offset = 0;
    for (const pending of this.queue) pending.entry.chunk.samples.fill(0);
    this.queue = [];
    this.clearTail();
  }

  push(chunk: PcmChunk, threshold: number, mode: KeywordMode) {
    if (
      !validPcmChunk(chunk) ||
      (this.sequence !== null && chunk.sequence !== this.sequence + 1)
    ) {
      this.reset();
      this.failed();
      return;
    }
    if (!this.identity || mode !== this.mode) {
      this.reset();
      this.mode = mode;
    }
    this.sequence = chunk.sequence;
    const entry = {
      chunk: { ...chunk, samples: chunk.samples.slice() },
      offset: this.offset,
    };
    this.offset += chunk.samples.length;
    if (mode === 'passive') {
      this.tail.push({
        chunk: { ...chunk, samples: chunk.samples.slice() },
        offset: entry.offset,
      });
      while (this.tail.length && this.offset - this.tail[0].offset > 48000)
        this.tail.shift()?.chunk.samples.fill(0);
    }
    if (this.queue.length >= 64) {
      entry.chunk.samples.fill(0);
      this.reset();
      this.failed();
      return;
    }
    this.queue.push({ entry, threshold, generation: this.generation });
    void this.drain();
  }

  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const pending = this.queue.shift();
        if (!pending) break;
        const { entry, threshold, generation } = pending;
        try {
          const reply = await this.port(
            entry.chunk.samples,
            this.identity,
            entry.chunk.sequence,
            threshold,
            this.mode,
          );
          if (generation !== this.generation) continue;
          if (reply.sequence !== entry.chunk.sequence) throw new Error();
          const detection = reply.detection;
          if (!detection) continue;
          if (
            detection.end_sample > entry.offset + entry.chunk.samples.length ||
            (this.mode === 'passive') !== (detection.command === 'ivy') ||
            (detection.command === 'prompt cancel' &&
              this.mode !== 'composing') ||
            (this.mode === 'composing' &&
              (detection.command === 'prompt' ||
                detection.command === 'reload mcp'))
          )
            throw new Error();
          const tail =
            detection.command === 'ivy'
              ? this.tail.flatMap(({ chunk, offset }) => {
                  const start = Math.max(0, detection.end_sample - offset);
                  return start >= chunk.samples.length
                    ? []
                    : [{ ...chunk, samples: chunk.samples.slice(start) }];
                })
              : [];
          this.reset();
          this.detected(detection, tail);
        } catch {
          if (generation === this.generation) {
            this.reset();
            this.failed();
          }
        } finally {
          entry.chunk.samples.fill(0);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private clearTail() {
    for (const entry of this.tail) entry.chunk.samples.fill(0);
    this.tail = [];
  }
}
