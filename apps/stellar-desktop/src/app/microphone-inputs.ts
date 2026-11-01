import { computed, signal } from '@angular/core';
import type { AudioInputDevice } from '@stellar/service-audio-activity';

export class MicrophoneInputs {
  readonly items = signal<readonly AudioInputDevice[]>([]);
  readonly visible = signal(false);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly selectedId = signal('');
  readonly selectedLabel = computed(() =>
    this.selectedId()
      ? (this.items().find((input) => input.deviceId === this.selectedId())
          ?.label ?? 'Selected microphone unavailable')
      : 'System default microphone',
  );
  private generation = 0;
  private disposed = false;

  constructor(
    private readonly audio: {
      listInputs(): Promise<readonly AudioInputDevice[]>;
    },
  ) {}

  async list() {
    if (this.disposed) return;
    const generation = ++this.generation;
    this.visible.set(true);
    this.loading.set(true);
    this.error.set(null);
    try {
      const inputs = await this.audio.listInputs();
      if (this.disposed || generation !== this.generation) return;
      this.items.set(inputs);
      if (!inputs.length)
        this.error.set(
          'No named inputs available. Enable microphone to grant access, then refresh inputs.',
        );
    } catch {
      if (!this.disposed && generation === this.generation)
        this.error.set(
          'Inputs could not be listed. You can use the system default or refresh inputs.',
        );
    } finally {
      if (!this.disposed && generation === this.generation)
        this.loading.set(false);
    }
  }

  select(deviceId: string): boolean {
    if (
      this.disposed ||
      (deviceId &&
        !this.items().some((input) => input.deviceId === deviceId)) ||
      deviceId === this.selectedId()
    )
      return false;
    ++this.generation;
    this.loading.set(false);
    this.selectedId.set(deviceId);
    return true;
  }

  dispose() {
    this.disposed = true;
    ++this.generation;
  }
}
