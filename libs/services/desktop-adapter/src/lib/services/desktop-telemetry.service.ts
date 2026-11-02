import {
  DestroyRef,
  Injectable,
  InjectionToken,
  computed,
  inject,
  signal,
} from '@angular/core';
import {
  decodeTelemetrySnapshot,
  telemetrySnapshotCommand,
  type TelemetrySnapshot,
} from '@stellar/desktop-contracts';

type TelemetryTransport = () => Promise<unknown>;
export const DESKTOP_TELEMETRY_TRANSPORT =
  new InjectionToken<TelemetryTransport>('DesktopTelemetryTransport', {
    providedIn: 'root',
    factory: () => {
      const api = (
        globalThis as typeof globalThis & {
          __TAURI__?: { core: { invoke(command: string): Promise<unknown> } };
        }
      ).__TAURI__;
      return api
        ? () => api.core.invoke(telemetrySnapshotCommand)
        : () => Promise.reject(new Error('Unavailable'));
    },
  });

@Injectable({ providedIn: 'root' })
export class DesktopTelemetryService {
  private readonly transport = inject(DESKTOP_TELEMETRY_TRANSPORT);
  private readonly snapshot = signal<TelemetrySnapshot | null>(null);
  private readonly status = signal<'unavailable' | 'loading' | 'available'>(
    'unavailable',
  );
  private readonly now = signal(Date.now());
  private owners = 0;
  private generation = 0;
  private pending = false;
  private timer?: ReturnType<typeof setInterval>;
  private expiry?: ReturnType<typeof setTimeout>;
  readonly state = computed(() => {
    const snapshot = this.snapshot();
    const age = snapshot
      ? this.now() - Date.parse(snapshot.observedAt)
      : Infinity;
    const fresh = this.status() === 'available' && age >= 0 && age < 10_000;
    return {
      status: this.status(),
      fresh,
      snapshot: snapshot
        ? {
            ...snapshot,
            agents: snapshot.agents.map((a) => {
              const sourceAge = this.now() - Date.parse(a.source.observedAt);
              const live =
                fresh &&
                a.source.health === 'available' &&
                sourceAge >= 0 &&
                sourceAge < 10_000;
              return {
                ...a,
                state: live ? a.state : ('unknown' as const),
                activity: live && a.state === 'running' ? a.activity : null,
                tool: live && a.state === 'running' ? a.tool : null,
              };
            }),
          }
        : null,
    };
  });
  constructor() {
    inject(DestroyRef).onDestroy(() => this.stopAll());
  }
  acquire(): () => void {
    if (++this.owners === 1) {
      this.generation++;
      this.status.set('loading');
      void this.refresh();
      this.timer = setInterval(() => {
        this.now.set(Date.now());
        void this.refresh();
      }, 5000);
    }
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      if (this.owners > 0 && --this.owners === 0) this.stopAll();
    };
  }
  private stopAll() {
    this.owners = 0;
    this.generation++;
    if (this.timer) clearInterval(this.timer);
    if (this.expiry) clearTimeout(this.expiry);
    this.timer = undefined;
    this.expiry = undefined;
    this.status.set('unavailable');
  }
  private scheduleExpiry() {
    if (this.expiry) clearTimeout(this.expiry);
    const current = this.snapshot();
    if (!current) return;
    const now = Date.now();
    const deadlines = [
      current.observedAt,
      ...current.agents.map((a) => a.source.observedAt),
    ]
      .map((value) => Date.parse(value) + 10_000)
      .filter((deadline) => deadline > now);
    if (deadlines.length)
      this.expiry = setTimeout(
        () => {
          this.now.set(Date.now());
          this.scheduleExpiry();
        },
        Math.min(...deadlines) - now,
      );
  }
  private async refresh() {
    if (this.pending) return;
    this.pending = true;
    const generation = this.generation;
    try {
      const incoming = decodeTelemetrySnapshot(await this.transport());
      if (generation !== this.generation) return;
      const current = this.snapshot();
      if (
        !current ||
        Date.parse(incoming.observedAt) > Date.parse(current.observedAt) ||
        (incoming.observedAt === current.observedAt &&
          incoming.sequence >= current.sequence)
      )
        this.snapshot.set(incoming);
      this.now.set(Date.now());
      this.status.set('available');
      this.scheduleExpiry();
    } catch {
      if (generation === this.generation) this.status.set('unavailable');
    } finally {
      this.pending = false;
      if (generation !== this.generation && this.owners > 0)
        void this.refresh();
    }
  }
}
