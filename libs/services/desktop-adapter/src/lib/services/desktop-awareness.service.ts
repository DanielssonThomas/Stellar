import {
  computed,
  DestroyRef,
  inject,
  Injectable,
  InjectionToken,
  NgZone,
  signal,
} from '@angular/core';
import {
  awarenessEvent,
  awarenessSetEnabledCommand,
  awarenessSnapshotCommand,
  awarenessWorkspaceCommand,
  decodeAwarenessSnapshot,
  type AwarenessSnapshot,
  type AwarenessWorkspace,
} from '@stellar/desktop-contracts';

export interface AwarenessTransport {
  invoke(command: string, request: unknown): Promise<unknown>;
  listen(listener: (payload: unknown) => void): Promise<() => void>;
}
export const AWARENESS_TRANSPORT = new InjectionToken<AwarenessTransport>(
  'DesktopAwarenessTransport',
  {
    providedIn: 'root',
    factory: () => {
      const api = (
        globalThis as typeof globalThis & {
          __TAURI__?: {
            core: {
              invoke(
                command: string,
                args: { request: unknown },
              ): Promise<unknown>;
            };
            event: {
              listen(
                event: string,
                callback: (event: { payload: unknown }) => void,
              ): Promise<() => void>;
            };
          };
        }
      ).__TAURI__;
      return api
        ? {
            invoke: (command, request) => api.core.invoke(command, { request }),
            listen: (listener) =>
              api.event.listen(awarenessEvent, (event) =>
                listener(event.payload),
              ),
          }
        : {
            invoke: () => Promise.reject(new Error('Unavailable')),
            listen: async () => () => undefined,
          };
    },
  },
);

@Injectable({ providedIn: 'root' })
export class DesktopAwarenessService {
  private readonly transport = inject(AWARENESS_TRANSPORT);
  private readonly zone = inject(NgZone);
  private readonly snapshot = signal<AwarenessSnapshot | null>(null);
  private readonly failed = signal(false);
  private readonly clock = signal(Date.now());
  private disposed = false;
  private started = false;
  private stop?: () => void;
  private timer?: ReturnType<typeof setInterval>;
  private highest = -1n;
  private pendingWorkspace?: AwarenessWorkspace;
  private workspaceSending = false;
  readonly state = this.snapshot.asReadonly();
  readonly enabled = computed(() => this.snapshot()?.enabled ?? true);
  readonly status = computed(() => {
    const snapshot = this.snapshot();
    if (this.failed() || !snapshot) return 'Awareness unavailable';
    if (!snapshot.enabled) return 'Awareness paused';
    const app = snapshot.foreground;
    const age = app ? this.clock() - Number(app.observed_at_ms) : Infinity;
    const appStatus =
      snapshot.app_health === 'available' && age >= 0 && age < 5_000
        ? 'App awareness active'
        : 'App observation unavailable';
    const mediaAge = snapshot.media_observed_at_ms
      ? this.clock() - Number(snapshot.media_observed_at_ms)
      : Infinity;
    const mediaStatus =
      snapshot.media_health !== 'available' ||
      mediaAge < 0 ||
      mediaAge >= 15_000
        ? 'Spotify observation unavailable'
        : snapshot.spotify
          ? `Spotify ${snapshot.spotify.playing ? 'playing' : 'paused'}`
          : 'No local Spotify session';
    return `${appStatus} · ${mediaStatus}`;
  });
  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.disposed = true;
      this.stop?.();
      clearInterval(this.timer);
      this.pendingWorkspace = undefined;
    });
  }
  async start() {
    if (this.started || this.disposed) return;
    this.started = true;
    this.timer = setInterval(() => this.clock.set(Date.now()), 1000);
    try {
      const stop = await this.transport.listen((payload) =>
        this.zone.run(() => this.accept(payload)),
      );
      if (this.disposed) {
        stop();
        return;
      }
      this.stop = stop;
      this.accept(
        await this.transport.invoke(awarenessSnapshotCommand, { version: 1 }),
      );
    } catch {
      if (!this.disposed) this.failed.set(true);
    }
  }
  async setEnabled(enabled: boolean) {
    if (this.disposed) return;
    try {
      this.accept(
        await this.transport.invoke(awarenessSetEnabledCommand, {
          version: 1,
          enabled,
        }),
      );
    } catch {
      if (!this.disposed) this.failed.set(true);
    }
  }
  workspace(value: AwarenessWorkspace) {
    if (this.disposed || !this.enabled()) return;
    this.pendingWorkspace = value;
    void this.flushWorkspace();
  }
  private async flushWorkspace() {
    if (this.workspaceSending || this.disposed) return;
    this.workspaceSending = true;
    try {
      while (!this.disposed && this.pendingWorkspace) {
        const value = this.pendingWorkspace;
        this.pendingWorkspace = undefined;
        try {
          await this.transport.invoke(awarenessWorkspaceCommand, value);
        } catch {
          /* A session transition fences the old workspace; the next observation retries. */
        }
      }
    } finally {
      this.workspaceSending = false;
    }
  }
  private accept(value: unknown) {
    if (this.disposed) return;
    try {
      const snapshot = decodeAwarenessSnapshot(value);
      const revision = BigInt(snapshot.revision);
      if (revision < this.highest) return;
      this.highest = revision;
      this.snapshot.set(snapshot);
      this.failed.set(false);
      this.clock.set(Date.now());
    } catch {
      this.failed.set(true);
    }
  }
}
