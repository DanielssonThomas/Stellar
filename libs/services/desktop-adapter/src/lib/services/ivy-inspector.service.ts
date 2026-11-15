import {
  DestroyRef,
  Injectable,
  InjectionToken,
  inject,
  signal,
} from '@angular/core';
import {
  decodeIvyInspectorSnapshot,
  ivyInspectCommand,
  type IvyInspectorRequest,
  type IvyInspectorSnapshot,
  type IvySessionSummary,
  type IvySessionMessage,
} from '@stellar/desktop-contracts';

export type IvyInspectorRead = (
  request: IvyInspectorRequest,
) => Promise<unknown>;
export const IVY_INSPECTOR_READ = new InjectionToken<IvyInspectorRead>(
  'IvyInspectorRead',
  {
    providedIn: 'root',
    factory: () => {
      const api = (
        globalThis as typeof globalThis & {
          __TAURI__?: {
            core: {
              invoke: (
                command: string,
                args: { request: IvyInspectorRequest },
              ) => Promise<unknown>;
            };
          };
        }
      ).__TAURI__;
      return api
        ? (request) => api.core.invoke(ivyInspectCommand, { request })
        : async () => {
            throw new Error('Unavailable in browser preview');
          };
    },
  },
);

@Injectable({ providedIn: 'root' })
export class IvyInspectorService {
  private readonly read = inject(IVY_INSPECTOR_READ);
  readonly snapshot = signal<IvyInspectorSnapshot | null>(null);
  readonly sessions = signal<readonly IvySessionSummary[]>([]);
  readonly messages = signal<readonly IvySessionMessage[]>([]);
  readonly loading = signal(false);
  readonly error = signal('');
  private generation = 0;
  private selected: string | null = null;
  private catalogNext: number | null = null;
  private messageNext: number | null = null;
  private pagedSessions = false;
  private pagedMessages = false;
  private timer?: ReturnType<typeof setInterval>;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.close());
  }
  open() {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), 2500);
  }
  close() {
    clearInterval(this.timer);
    this.timer = undefined;
    this.generation++;
    this.loading.set(false);
  }
  select(id: string | null) {
    this.generation++;
    this.loading.set(false);
    this.selected = id;
    this.messageNext = null;
    this.pagedMessages = false;
    this.messages.set([]);
    void this.refresh();
  }
  moreSessions() {
    const next = this.catalogNext;
    if (next === null || next === undefined) return;
    void this.fetch(next, null, 'catalog');
  }
  olderMessages() {
    const next = this.messageNext;
    if (next === null || next === undefined) return;
    void this.fetch(0, next, 'messages');
  }
  async refresh() {
    return this.fetch(0, null, 'refresh');
  }
  private async fetch(
    offset: number,
    before: number | null,
    kind: 'refresh' | 'catalog' | 'messages',
  ) {
    if (this.loading()) return;
    const generation = this.generation;
    this.loading.set(true);
    try {
      const snapshot = decodeIvyInspectorSnapshot(
        await this.read({
          version: 1,
          session_id: this.selected,
          offset,
          before_message: before,
        }),
      );
      if (generation !== this.generation) return;
      const prior = this.snapshot();
      const same = prior?.selected_session_id === snapshot.selected_session_id;
      if (!same) this.pagedMessages = false;
      if (kind === 'catalog') this.pagedSessions = true;
      if (kind === 'messages') this.pagedMessages = true;
      if (!this.pagedSessions || kind === 'catalog')
        this.catalogNext = snapshot.next_offset;
      if (!this.pagedMessages || kind === 'messages')
        this.messageNext = snapshot.next_before;
      const sessions = new Map(this.sessions().map((s) => [s.id, s]));
      snapshot.sessions.forEach((s) => sessions.set(s.id, s));
      this.sessions.set(
        [...sessions.values()]
          .sort(
            (a, b) =>
              Date.parse(b.last_activity_at ?? b.started_at ?? '1970-01-01') -
              Date.parse(a.last_activity_at ?? a.started_at ?? '1970-01-01'),
          )
          .slice(0, 2000),
      );
      const messages = new Map(
        (same ? this.messages() : []).map((m) => [m.id, m]),
      );
      snapshot.messages.forEach((m) => messages.set(m.id, m));
      if (messages.size >= 400) this.messageNext = null;
      this.messages.set(
        [...messages.values()].sort((a, b) => a.id - b.id).slice(-400),
      );
      this.snapshot.set({
        ...snapshot,
        next_offset: this.catalogNext,
        next_before: this.messageNext,
      });
      this.error.set('');
    } catch {
      if (generation === this.generation)
        this.error.set(
          'Session details unavailable. Retry when Ivy is connected.',
        );
    } finally {
      if (generation === this.generation) this.loading.set(false);
    }
  }
}
