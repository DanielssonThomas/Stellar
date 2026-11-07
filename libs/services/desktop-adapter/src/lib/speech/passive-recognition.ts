import {
  createUtteranceAssembler,
  type ActivitySnapshot,
  type PcmChunk,
} from '@stellar/service-audio-activity';
import type { SpeechTranscript } from '@stellar/desktop-contracts';

/** One settled local utterance at a time; no submission authority or stored history. */
export class PassiveRecognition {
  private readonly assembler = createUtteranceAssembler({ silenceMs: 800 });
  private generation = 0;
  private running?: {
    readonly id: string;
    readonly promise: Promise<void>;
    readonly pcm: Int16Array;
  };
  private capped = false;
  private quietSamples = 0;
  constructor(
    private readonly ports: {
      collect: (pcm: Int16Array, id: string) => Promise<SpeechTranscript>;
      id: () => string;
      completed: (text: string, id: string) => void;
    },
  ) {}
  push(chunk: PcmChunk, activity: ActivitySnapshot) {
    if (this.capped) {
      this.quietSamples =
        activity.active || activity.starting || activity.calibrating
          ? 0
          : this.quietSamples + chunk.samples.length;
      this.assembler.reset();
      if (this.quietSamples >= 12_800) {
        this.capped = false;
        this.quietSamples = 0;
      }
      return;
    }
    const pcm = this.assembler.push(chunk, activity);
    if (!pcm) return;
    if (this.assembler.lastResultCapped()) {
      this.capped = true;
      this.quietSamples = 0;
      this.assembler.reset();
      pcm.fill(0);
      return;
    }
    if (this.running) {
      pcm.fill(0);
      return;
    }
    const id = this.ports.id();
    const generation = this.generation;
    let text: string | undefined;
    let request: Promise<SpeechTranscript>;
    try {
      request = this.ports.collect(pcm, id);
    } catch {
      request = Promise.reject(new Error('Local collect failed'));
    }
    const pending = request
      .then((result) => {
        if (generation === this.generation && result?.utterance_id === id)
          text = result.text;
      })
      .catch(() => undefined)
      .finally(() => {
        pcm.fill(0);
        if (this.running?.promise === pending) this.running = undefined;
      });
    this.running = { id, promise: pending, pcm };
    // Native collect has settled and released its PCM/ownership before admission can wait on it.
    void pending
      .then(() => {
        if (generation === this.generation && text !== undefined)
          this.ports.completed(text, id);
      })
      .catch(() => undefined);
  }
  wait() {
    return this.running?.promise;
  }
  pending() {
    return this.running;
  }
  reset() {
    ++this.generation;
    this.running?.pcm.fill(0);
    this.assembler.reset();
    this.capped = false;
    this.quietSamples = 0;
  }
}
