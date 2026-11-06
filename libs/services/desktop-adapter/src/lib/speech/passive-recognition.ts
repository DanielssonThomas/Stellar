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
  private running?: Promise<void>;
  constructor(
    private readonly ports: {
      collect: (pcm: Int16Array, id: string) => Promise<SpeechTranscript>;
      id: () => string;
      completed: (text: string) => void;
    },
  ) {}
  push(chunk: PcmChunk, activity: ActivitySnapshot) {
    const pcm = this.assembler.push(chunk, activity);
    if (!pcm) return;
    if (this.running || this.assembler.lastResultCapped()) {
      pcm.fill(0);
      return;
    }
    const id = this.ports.id();
    const generation = this.generation;
    const pending = this.ports
      .collect(pcm, id)
      .then((result) => {
        if (generation === this.generation && result.utterance_id === id)
          this.ports.completed(result.text);
      })
      .catch(() => undefined)
      .finally(() => {
        pcm.fill(0);
        if (this.running === pending) this.running = undefined;
      });
    this.running = pending;
  }
  wait() {
    return this.running;
  }
  reset() {
    ++this.generation;
    this.assembler.reset();
  }
}
