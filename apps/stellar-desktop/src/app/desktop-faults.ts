import { computed, Injectable, signal, untracked } from '@angular/core';

export type FaultSource =
  | 'assistant'
  | 'voice'
  | 'artwork'
  | 'microphone'
  | 'desktop';
export type FaultStatus = 'active' | 'recovering' | 'resolved';

export interface DesktopFaultEntry {
  readonly id: number;
  readonly time: string;
  readonly category: string;
  readonly message: string;
  readonly status: FaultStatus;
  readonly count: number;
}

type StoredFault = DesktopFaultEntry & {
  readonly source: FaultSource;
  readonly code: string;
};

const definitions: Record<
  FaultSource,
  { category: string; messages: Readonly<Record<string, string>> }
> = {
  assistant: {
    category: 'Ivy',
    messages: {
      malformed_request: 'Ivy could not accept the request.',
      unavailable: 'Ivy is unavailable. Connect to retry.',
      timeout:
        'Ivy did not respond in time. Check the response before retrying.',
      busy: 'Ivy is still processing another operation.',
      protocol: 'Ivy returned an unexpected response.',
      uncertain:
        'The Ivy response is uncertain. Check the response before sending again.',
      storage: 'Ivy conversation state could not be saved.',
      approval_required: 'Ivy needs approval in its own client.',
      turn_failed: 'The Ivy request failed. You can try again.',
      failed: 'The Ivy request failed. You can try again.',
      disconnected: 'Ivy is disconnected. Connect to retry.',
      recovery_failed:
        'Ivy recovery did not complete. Check the response and retry.',
    },
  },
  voice: {
    category: 'Voice',
    messages: {
      malformed_request: 'The local voice request was invalid.',
      unsupported_version: 'The local voice service is incompatible.',
      busy: 'The local voice service is busy.',
      unavailable: 'Local voice is unavailable. Retry voice.',
      model_missing: 'A local voice model is unavailable.',
      timeout: 'The local voice request timed out. Retry voice.',
      cancelled: 'The local voice request was interrupted.',
      protocol: 'The local voice service returned an unexpected response.',
      cleanup: 'The prompt could not be refined. Your draft is retained.',
      session:
        'Conversation state is unavailable. Refresh it before voice resumes.',
      failure: 'Local voice could not complete the request. Retry voice.',
    },
  },
  artwork: {
    category: 'Artwork',
    messages: {
      unavailable:
        'The emblem artwork could not be loaded. Check the installation and restart the app.',
    },
  },
  microphone: {
    category: 'Microphone',
    messages: {
      denied:
        'Microphone permission was denied. Enable it manually, then use Enable microphone.',
      missing:
        'The selected microphone is unavailable. Choose another microphone in the controls.',
      disconnected:
        'The microphone was disconnected. Reconnect it or choose another microphone.',
      unavailable: 'The microphone could not be started or released.',
    },
  },
  desktop: {
    category: 'Desktop',
    messages: {
      runtime:
        'The interface encountered an unexpected error. Restart the app; your conversation is retained.',
      unavailable: 'The desktop connection is unavailable.',
      protocol: 'The desktop received an unexpected response.',
      timeout: 'The desktop request timed out.',
    },
  },
};

@Injectable()
export class DesktopFaults {
  private readonly history = signal<readonly StoredFault[]>([]);
  private readonly opened = signal(false);
  private nextId = 0;

  readonly entries = computed<readonly DesktopFaultEntry[]>(() =>
    this.history().map(({ id, time, category, message, status, count }) =>
      Object.freeze({ id, time, category, message, status, count }),
    ),
  );
  readonly active = computed(() =>
    this.history().some((entry) => entry.status !== 'resolved'),
  );
  readonly visible = computed(() => this.active() || this.opened());

  observe(source: FaultSource, code: string | null): void {
    untracked(() => this.record(source, code));
  }

  private record(source: FaultSource, code: string | null): void {
    if (!Object.hasOwn(definitions, source)) return;
    const definition = definitions[source];
    const known =
      code !== null && Object.hasOwn(definition.messages, code)
        ? code
        : 'unknown';
    const current = this.history().find(
      (entry) => entry.source === source && entry.status !== 'resolved',
    );
    if (code === null && !current) return;
    if (code !== null && current?.code === known) return;
    let entries = this.history().map((entry) =>
      entry.source === source && entry.status !== 'resolved'
        ? { ...entry, status: 'resolved' as const }
        : entry,
    );
    if (code !== null) {
      this.opened.set(true);
      const previous = entries.find(
        (entry) => entry.source === source && entry.code === known,
      );
      const now = new Date().toISOString();
      const next: StoredFault = previous
        ? {
            ...previous,
            time: now,
            status: 'active',
            count: previous.count + 1,
          }
        : {
            id: ++this.nextId,
            time: now,
            category: definition.category,
            source,
            code: known,
            message:
              definition.messages[known] ??
              `${definition.category} reported an unexpected fault.`,
            status: 'active',
            count: 1,
          };
      entries = [next, ...entries.filter((entry) => entry.id !== next.id)];
      if (entries.length > 8) {
        let index = entries.length - 1;
        while (index >= 0 && entries[index].status !== 'resolved') index--;
        if (index >= 0) entries.splice(index, 1);
      }
    }
    this.history.set(entries);
  }

  beginRecovery(source: FaultSource): void {
    this.changeStatus(source, 'active', 'recovering');
  }

  endRecovery(source: FaultSource, success: boolean): void {
    this.changeStatus(source, 'recovering', success ? 'resolved' : 'active');
  }

  dismiss(): void {
    if (!this.active()) this.opened.set(false);
  }

  show(): void {
    this.opened.set(true);
  }

  private changeStatus(
    source: FaultSource,
    from: FaultStatus,
    to: FaultStatus,
  ): void {
    this.history.update((entries) =>
      entries.map((entry) =>
        entry.source === source && entry.status === from
          ? { ...entry, status: to }
          : entry,
      ),
    );
  }
}
