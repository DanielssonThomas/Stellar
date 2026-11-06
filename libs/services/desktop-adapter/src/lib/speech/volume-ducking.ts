import {
  decodeSpeechDuckingRequest,
  speechSetDuckingCommand,
} from '@stellar/desktop-contracts';
import type { SpeechTransport } from './speech-transport';

/** Keeps a native lease only while a foreground voice interaction needs it. */
export class VolumeDucking {
  private active = false;
  private disposed = false;
  private heartbeat?: ReturnType<typeof setInterval>;
  private release?: ReturnType<typeof setTimeout>;
  private pending = Promise.resolve();

  constructor(private readonly transport: SpeechTransport) {}

  set(active: boolean, listening = false) {
    if (this.disposed) return;
    if (active) {
      clearTimeout(this.release);
      this.release = undefined;
      if (this.active) return;
      this.active = true;
      this.send(true);
      this.heartbeat = setInterval(() => this.send(true), 2000);
    } else if (this.active && !this.release) {
      if (listening) {
        // Bridge the utterance assembler's 1.4-second end-of-speech boundary.
        this.release = setTimeout(() => this.stop(), 1600);
      } else this.stop();
    } else if (!listening && this.release) this.stop();
  }

  private stop() {
    clearTimeout(this.release);
    clearInterval(this.heartbeat);
    this.release = undefined;
    this.heartbeat = undefined;
    if (!this.active) return;
    this.active = false;
    this.send(false);
  }

  private send(active: boolean) {
    this.pending = this.pending
      .then(async () => {
        if (active !== this.active) return;
        const reply = await this.transport.invoke(speechSetDuckingCommand, {
          request: decodeSpeechDuckingRequest({ version: 1, active }),
        });
        if (reply !== null) throw new Error('Invalid volume acknowledgment');
      })
      .catch(() => {
        // Voice remains usable if endpoint control is unavailable. The native
        // lease restores volume independently if IPC delivery stops succeeding.
      });
  }

  dispose() {
    if (this.disposed) return;
    this.stop();
    this.disposed = true;
  }
}
