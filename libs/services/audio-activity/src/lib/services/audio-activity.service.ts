import { DestroyRef, Injectable, NgZone, inject, signal } from '@angular/core';
import { AudioActivityController } from '../audio-activity-controller';
import { WebAudioSource } from '../web-audio-source';
import type { AudioSource } from '../audio-model';
import { listAudioInputs } from '../audio-inputs';
import type { PcmEvent } from '../pcm-model';

@Injectable({ providedIn: 'root' })
export class AudioActivityService {
  private readonly zone = inject(NgZone);
  private readonly controller = new AudioActivityController((state) =>
    this.zone.run(() => this.current.set(state)),
  );
  private readonly current = signal(this.controller.snapshot());
  readonly state = this.current.asReadonly();

  constructor() {
    const unbind =
      typeof document !== 'undefined' && typeof window !== 'undefined'
        ? this.zone.runOutsideAngular(() =>
            this.controller.bindLifecycle(document, window),
          )
        : () => undefined;
    inject(DestroyRef).onDestroy(() => {
      unbind();
      void this.zone.runOutsideAngular(() => this.controller.dispose());
    });
  }

  startMicrophone(deviceId?: string): Promise<void> {
    return this.start(new WebAudioSource(), deviceId);
  }

  listInputs() {
    return listAudioInputs();
  }

  subscribePcm(listener: (event: PcmEvent) => void): () => void {
    return this.controller.subscribePcm(listener);
  }

  start(source: AudioSource, deviceId?: string): Promise<void> {
    return this.zone.runOutsideAngular(() =>
      this.controller.start(source, deviceId),
    );
  }

  stop(): Promise<void> {
    return this.zone.runOutsideAngular(() => this.controller.stop());
  }

  mute(): Promise<void> {
    return this.zone.runOutsideAngular(() => this.controller.stop('muted'));
  }

  suspend(): Promise<void> {
    return this.zone.runOutsideAngular(() => this.controller.suspend());
  }
}
