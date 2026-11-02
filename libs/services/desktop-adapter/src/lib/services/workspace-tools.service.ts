import {
  computed,
  DestroyRef,
  Injectable,
  InjectionToken,
  inject,
  signal,
} from '@angular/core';
import {
  decodeWorkspaceToolOutcome,
  decodeWorkspaceToolRequest,
  workspaceToolEvent,
  workspaceToolReplyCommand,
  type WorkspaceToolOutcome,
  type WorkspaceToolReply,
  type WorkspaceToolRequest,
} from '@stellar/desktop-contracts';
import { IvyAdapterService } from './ivy-adapter.service';

export type WorkspaceToolHandler = (
  request: WorkspaceToolRequest,
) => WorkspaceToolOutcome;
export interface WorkspaceToolTransport {
  listen(callback: (value: unknown) => void): Promise<() => void>;
  reply(value: WorkspaceToolReply): Promise<void>;
}
type NativeApi = {
  core: {
    invoke(
      command: string,
      args: { request: WorkspaceToolReply },
    ): Promise<unknown>;
  };
  event: {
    listen(
      event: string,
      callback: (event: { payload: unknown }) => void,
    ): Promise<() => void>;
  };
};

export const WORKSPACE_TOOL_TRANSPORT =
  new InjectionToken<WorkspaceToolTransport | null>('WorkspaceToolTransport', {
    providedIn: 'root',
    factory: () => {
      const api = (globalThis as typeof globalThis & { __TAURI__?: NativeApi })
        .__TAURI__;
      return api
        ? {
            listen: (callback) =>
              api.event.listen(workspaceToolEvent, (event) =>
                callback(event.payload),
              ),
            reply: async (request) => {
              await api.core.invoke(workspaceToolReplyCommand, { request });
            },
          }
        : null;
    },
  });

@Injectable({ providedIn: 'root' })
export class WorkspaceToolsService {
  private readonly ivy = inject(IvyAdapterService);
  private readonly transport = inject(WORKSPACE_TOOL_TRANSPORT);
  private readonly listening = signal(false);
  private handler?: WorkspaceToolHandler;
  private pending = false;
  private deadline?: { id: string; monotonic: number };
  private disposed = false;
  private unlisten?: () => void;
  readonly ready = this.listening.asReadonly();
  readonly status = computed(() => this.ivy.state().workspace_tools);

  constructor() {
    if (this.transport) {
      void this.transport
        .listen((value) => {
          void this.accept(value);
        })
        .then((unlisten) => {
          if (this.disposed) unlisten();
          else {
            this.unlisten = unlisten;
            this.listening.set(true);
          }
        })
        .catch(() => this.listening.set(false));
    }
    inject(DestroyRef).onDestroy(() => {
      this.disposed = true;
      this.handler = undefined;
      this.unlisten?.();
      this.listening.set(false);
    });
  }

  bind(handler: WorkspaceToolHandler): () => void {
    this.handler = handler;
    return () => {
      if (this.handler === handler) this.handler = undefined;
    };
  }

  isCurrent(request: WorkspaceToolRequest): boolean {
    const state = this.ivy.state();
    return (
      !this.disposed &&
      Date.now() < Number(request.expires_at_ms) &&
      this.deadline?.id === request.request_id &&
      performance.now() < this.deadline.monotonic &&
      state.connection === 'ready' &&
      state.workspace_epoch === request.epoch &&
      state.turn_id === request.turn_id &&
      ['submitting', 'admitted'].includes(state.turn)
    );
  }

  private async accept(value: unknown) {
    let request: WorkspaceToolRequest;
    try {
      request = decodeWorkspaceToolRequest(value);
    } catch {
      return;
    }
    if (!this.transport || this.disposed || this.pending) return;
    const remaining = Number(request.expires_at_ms) - Date.now();
    if (remaining <= 0 || remaining > 15000) return;
    this.deadline = { id: request.request_id, monotonic: performance.now() + remaining };
    this.pending = true;
    let outcome: WorkspaceToolOutcome = { kind: 'rejected' };
    try {
      await this.ivy.snapshot();
      if (
        this.isCurrent(request) &&
        this.handler &&
        request.operation.kind !== 'capture_window'
      )
        outcome = decodeWorkspaceToolOutcome(this.handler(request), request);
    } catch {
      outcome = { kind: 'rejected' };
    }
    try {
      if (!this.disposed)
        await this.transport.reply({
          version: 1,
          request_id: request.request_id,
          epoch: request.epoch,
          turn_id: request.turn_id,
          outcome,
        });
    } catch {
      /* The native owner may already have cancelled or timed out. */
    } finally {
      this.pending = false;
      this.deadline = undefined;
    }
  }
}
