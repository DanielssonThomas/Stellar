import {
  DestroyRef,
  inject,
  Injectable,
  InjectionToken,
  signal,
} from '@angular/core';
import type {
  SpeechSnapshot,
  SpeechTranscript,
} from '@stellar/desktop-contracts';
import { SpeechAdapter, SpeechAdapterError } from '../speech/speech-adapter';
import {
  browserSpeechTransport,
  initialSpeechSnapshot,
  nativeSpeechTransport,
  type SpeechNativeApi,
  type SpeechTransport,
} from '../speech/speech-transport';

export const SPEECH_TRANSPORT = new InjectionToken<SpeechTransport>(
  'SpeechTransport',
  {
    providedIn: 'root',
    factory: () => {
      const api = (
        globalThis as typeof globalThis & { __TAURI__?: SpeechNativeApi }
      ).__TAURI__;
      return api ? nativeSpeechTransport(api) : browserSpeechTransport();
    },
  },
);

@Injectable({ providedIn: 'root' })
export class SpeechAdapterService {
  private readonly adapter = new SpeechAdapter(inject(SPEECH_TRANSPORT));
  private readonly current = signal(initialSpeechSnapshot());
  readonly state = this.current.asReadonly();
  private disposed = false;
  private generation = 0;
  private highestRevision = -1n;
  private localFailure = false;
  private subscription?: Promise<() => void>;
  private prepared?: Promise<void>;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.disposed = true;
      ++this.generation;
      try {
        this.adapter.dispose();
      } catch {
        /* Native shutdown independently reaps owned speech resources. */
      }
    });
  }

  transcribe(pcm: Int16Array, utteranceId: string): Promise<SpeechTranscript> {
    if (!pcm.length || pcm.length > 320000)
      return Promise.reject(new SpeechAdapterError('contract'));
    const generation = this.generation;
    return this.run(async () => {
      await this.prepare();
      this.assertCurrent(generation);
      return this.adapter.transcribe({
        version: 1,
        epoch: this.current().epoch,
        utterance_id: utteranceId,
        sample_rate_hz: 16000,
        pcm: Array.from(pcm),
      });
    });
  }

  speak(text: string, utteranceId: string): Promise<SpeechSnapshot> {
    const generation = this.generation;
    return this.run(async () => {
      await this.prepare();
      this.assertCurrent(generation);
      const snapshot = await this.adapter.speak({
        version: 1,
        epoch: this.current().epoch,
        utterance_id: utteranceId,
        text,
      });
      this.accept(snapshot, true);
      return this.current();
    });
  }

  stop(): Promise<SpeechSnapshot> {
    ++this.generation;
    return this.run(async () => {
      this.accept(await this.adapter.snapshot(), true);
      const snapshot = await this.adapter.stop(this.current().epoch);
      this.accept(snapshot, true);
      return this.current();
    });
  }

  private listen(): Promise<() => void> {
    if (!this.subscription) {
      const pending = this.adapter.subscribe(
        (snapshot) => this.accept(snapshot),
        (error) => this.failed(error),
      );
      this.subscription = pending;
      void pending.catch(() => {
        if (this.subscription === pending) this.subscription = undefined;
      });
    }
    return this.subscription;
  }

  private prepare(): Promise<void> {
    if (!this.prepared) {
      const pending = this.listen().then(async () => {
        this.accept(await this.adapter.snapshot(), true);
      });
      this.prepared = pending;
      void pending.catch(() => {
        if (this.prepared === pending) this.prepared = undefined;
      });
    }
    return this.prepared;
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      this.failed(error);
      throw error;
    }
  }

  private accept(snapshot: SpeechSnapshot, confirmedReply = false) {
    if (this.disposed) return;
    const revision = BigInt(snapshot.revision);
    if (
      revision < this.highestRevision ||
      (revision === this.highestRevision &&
        !(confirmedReply && this.localFailure))
    )
      return;
    this.highestRevision = revision;
    this.localFailure = false;
    this.current.set(snapshot);
  }

  private failed(error: unknown) {
    if (error instanceof SpeechAdapterError && error.code === 'cancelled')
      return;
    if (!this.disposed) {
      this.localFailure = true;
      this.current.update((state) => ({
        ...state,
        state: 'unavailable',
        error:
          error instanceof SpeechAdapterError &&
          error.kind === 'native' &&
          error.code
            ? error.code
            : 'protocol',
      }));
    }
  }

  private assertCurrent(generation: number) {
    if (this.disposed) throw new SpeechAdapterError('disposed');
    if (generation !== this.generation)
      throw new SpeechAdapterError('native', 'cancelled');
  }
}
