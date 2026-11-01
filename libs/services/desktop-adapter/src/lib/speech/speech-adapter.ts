import {
  decodeSpeechError,
  decodeSpeechRequest,
  decodeSpeechStopRequest,
  decodeSpeechSnapshot,
  decodeSpeechSpeakRequest,
  decodeSpeechTranscribeRequest,
  decodeSpeechTranscript,
  speechEvent,
  speechSnapshotCommand,
  speechSpeakCommand,
  speechStopCommand,
  speechTranscribeCommand,
  type SpeechCommands,
  type SpeechError,
  type SpeechSnapshot,
  type SpeechSpeakRequest,
  type SpeechTranscribeRequest,
  type SpeechTranscript,
} from '@stellar/desktop-contracts';
import type { SpeechTransport } from './speech-transport';

export class SpeechAdapterError extends Error {
  constructor(
    readonly kind: 'contract' | 'transport' | 'native' | 'disposed',
    readonly code?: SpeechError,
  ) {
    super('Speech adapter: ' + kind);
  }
}

interface Subscription {
  active: boolean;
  unlisten?: () => void;
}

export class SpeechAdapter {
  private disposed = false;
  private readonly subscriptions = new Set<Subscription>();
  constructor(private readonly transport: SpeechTransport) {}

  async transcribe(input: SpeechTranscribeRequest): Promise<SpeechTranscript> {
    const request = this.validate(() => decodeSpeechTranscribeRequest(input));
    const reply = await this.invoke(
      speechTranscribeCommand,
      request,
      decodeSpeechTranscript,
    );
    if (reply.utterance_id !== request.utterance_id)
      throw new SpeechAdapterError('contract');
    return reply;
  }

  speak(input: SpeechSpeakRequest): Promise<SpeechSnapshot> {
    const request = this.validate(() => decodeSpeechSpeakRequest(input));
    return this.invoke(speechSpeakCommand, request, decodeSpeechSnapshot);
  }

  snapshot(): Promise<SpeechSnapshot> {
    return this.invoke(
      speechSnapshotCommand,
      decodeSpeechRequest({ version: 1 }),
      decodeSpeechSnapshot,
    );
  }

  stop(epoch: string): Promise<SpeechSnapshot> {
    return this.invoke(
      speechStopCommand,
      this.validate(() => decodeSpeechStopRequest({ version: 1, epoch })),
      decodeSpeechSnapshot,
    );
  }

  async subscribe(
    callback: (snapshot: SpeechSnapshot) => void,
    onError: (error: SpeechAdapterError) => void,
  ): Promise<() => void> {
    this.assertActive();
    const entry: Subscription = { active: true };
    const stop = () => {
      if (!entry.active) return;
      entry.active = false;
      this.subscriptions.delete(entry);
      entry.unlisten?.();
    };
    this.subscriptions.add(entry);
    try {
      const unlisten = await this.transport.listen(speechEvent, (payload) => {
        if (!entry.active || this.disposed) return;
        let snapshot: SpeechSnapshot;
        try {
          snapshot = decodeSpeechSnapshot(payload);
        } catch {
          onError(new SpeechAdapterError('contract'));
          return;
        }
        callback(snapshot);
      });
      if (typeof unlisten !== 'function')
        throw new SpeechAdapterError('transport');
      if (!entry.active || this.disposed) unlisten();
      else entry.unlisten = unlisten;
      return stop;
    } catch {
      stop();
      this.assertActive();
      throw new SpeechAdapterError('transport');
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    let failed = false;
    for (const entry of this.subscriptions) {
      entry.active = false;
      try {
        entry.unlisten?.();
      } catch {
        failed = true;
      }
    }
    this.subscriptions.clear();
    if (failed) throw new SpeechAdapterError('transport');
  }

  private validate<T>(decode: () => T): T {
    this.assertActive();
    try {
      return decode();
    } catch {
      throw new SpeechAdapterError('contract');
    }
  }

  private async invoke<K extends keyof SpeechCommands, T>(
    command: K,
    request: SpeechCommands[K],
    decode: (value: unknown) => T,
  ): Promise<T> {
    this.assertActive();
    let payload: unknown;
    try {
      payload = await this.transport.invoke(command, { request });
    } catch (error) {
      this.assertActive();
      let code: SpeechError;
      try {
        code = decodeSpeechError(error);
      } catch {
        throw new SpeechAdapterError('transport');
      }
      throw new SpeechAdapterError('native', code);
    }
    this.assertActive();
    try {
      return decode(payload);
    } catch {
      throw new SpeechAdapterError('contract');
    }
  }

  private assertActive() {
    if (this.disposed) throw new SpeechAdapterError('disposed');
  }
}
