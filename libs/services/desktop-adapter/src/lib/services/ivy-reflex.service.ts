import {
  DestroyRef,
  Injectable,
  computed,
  inject,
  signal,
} from '@angular/core';
import {
  decodeReflexReply,
  decodeReflexAvailability,
  decodeReflexRouting,
  decodeReflexMediaState,
  decodeReflexMediaResult,
  type ReflexMediaAction,
  type ReflexMediaState,
  type ReflexMode,
} from '@stellar/desktop-contracts';
import type { LocalAction } from '../reflex/action-registry';
import { mediaActionDescriptions } from '../reflex/media-actions';
import { paneShortcut } from '../reflex/pane-shortcuts';
import { captureReflexDiagnostics } from '../reflex/reflex-diagnostics';
import { RequestTimeline, type RequestTrace } from '../reflex/request-timeline';
import {
  ReflexController,
  type ReflexEnvironment,
} from '../reflex/reflex-controller';

type Invoke = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;
type Workspace = () => {
  readonly context: string;
  readonly actions: readonly LocalAction[];
};

@Injectable({ providedIn: 'root' })
export class IvyReflexService {
  private readonly invoke: Invoke | undefined = (
    globalThis as typeof globalThis & {
      __TAURI__?: { core: { invoke: Invoke } };
    }
  ).__TAURI__?.core.invoke;
  private readonly preference = signal(this.readPreference());
  readonly enabled = this.preference.asReadonly();
  private readonly available = signal<boolean | null>(null);
  readonly localAvailable = computed(
    () => this.enabled() && !!this.invoke && this.available() !== false,
  );
  readonly status = computed(() =>
    !this.enabled()
      ? 'Disabled'
      : this.busy() || this.available() === null
        ? 'Starting'
        : this.available()
          ? 'Ready'
          : 'Unavailable',
  );
  readonly lastRoute = signal('');
  readonly diagnosticNotice = signal('');
  readonly requests = signal<readonly RequestTrace[]>([]);
  readonly timeline = new RequestTimeline((items) => this.requests.set(items));
  private traceEpoch = '';
  private settings: Promise<void> = Promise.resolve();
  private preparation: Promise<void> = Promise.resolve();
  private settingRevision = 0;
  readonly reply = signal('');
  readonly busy = signal(false);
  readonly mode = signal<ReflexMode>('professional');
  private workspace: Workspace = () => ({ context: '{}', actions: [] });
  private epoch: () => string = () => '0';
  private point?: (
    stage:
      | 'inference_start'
      | 'inference_complete'
      | 'action_dispatch'
      | 'action_complete',
  ) => void;
  private readonly controller = new ReflexController({
    environment: (signal, text) =>
      paneShortcut(text)
        ? Promise.resolve({ epoch: this.epoch(), ...this.workspace() })
        : this.environment(signal),
    currentEpoch: () => this.epoch(),
    point: (stage) => this.point?.(stage),
    infer: async (request, signal) => {
      if (!this.invoke || signal.aborted) return null;
      const cancel = () => {
        void this.invoke?.('reflex_cancel', {
          inputId: request.input_id,
        }).catch(() => undefined);
      };
      signal.addEventListener('abort', cancel, { once: true });
      try {
        const reply = await this.invoke('reflex_infer', { request });
        return signal.aborted
          ? null
          : decodeReflexReply(reply, request.input_id).plan;
      } finally {
        signal.removeEventListener('abort', cancel);
      }
    },
  });

  constructor() {
    this.configure(this.enabled());
    inject(DestroyRef).onDestroy(() => this.controller.cancel());
  }
  private readPreference(): boolean {
    try {
      return (
        globalThis.localStorage?.getItem('stellar.ivy-reflex.enabled') !==
        'false'
      );
    } catch {
      return true;
    }
  }
  setEnabled(enabled: boolean) {
    this.preference.set(enabled);
    try {
      globalThis.localStorage?.setItem(
        'stellar.ivy-reflex.enabled',
        String(enabled),
      );
    } catch {
      /* Session preference still applies when storage is unavailable. */
    }
    if (!enabled) this.controller.cancel();
    this.configure(enabled);
  }
  private configure(enabled: boolean) {
    const revision = ++this.settingRevision;
    this.available.set(null);
    let accepted = false;
    this.settings = this.settings.then(async () => {
      try {
        if (!this.invoke) throw Error('Native Reflex unavailable');
        await this.invoke('reflex_set_enabled', { enabled });
        accepted = true;
      } catch {
        if (revision === this.settingRevision) this.available.set(false);
      }
    });
    this.preparation = this.settings.then(async () => {
      try {
        if (
          !accepted ||
          !enabled ||
          revision !== this.settingRevision ||
          !this.invoke
        )
          return;
        const state = decodeReflexAvailability(
          await this.invoke('reflex_status'),
        );
        if (revision !== this.settingRevision) return;
        const prepared = state.configured
          ? decodeReflexAvailability(await this.invoke('reflex_prepare'))
              .configured
          : false;
        if (revision === this.settingRevision) this.available.set(prepared);
      } catch {
        if (revision === this.settingRevision) this.available.set(false);
      }
    });
  }
  async copyDiagnostics() {
    try {
      const report = captureReflexDiagnostics({
        enabled: this.enabled(),
        status: this.status(),
        last_route: this.lastRoute(),
        mode: this.mode(),
      });
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
      this.diagnosticNotice.set('Diagnostics copied');
    } catch {
      this.diagnosticNotice.set('Clipboard unavailable. Try again.');
    }
  }
  bind(workspace: Workspace, epoch: () => string) {
    this.workspace = workspace;
    this.epoch = epoch;
  }
  cancel() {
    this.controller.cancel();
  }
  clear() {
    this.controller.clear();
    this.reply.set('');
    this.timeline.clear();
  }
  beginTrace(id: string, text: string, source: RequestTrace['source']) {
    const epoch = this.epoch();
    if (epoch !== this.traceEpoch) {
      this.timeline.clear();
      this.traceEpoch = epoch;
    }
    this.timeline.begin(id, text, source);
  }
  events() {
    return this.controller.events();
  }
  acknowledgeEvents(events: ReturnType<IvyReflexService['events']>) {
    this.controller.acknowledgeEvents(events);
  }

  async run(
    text: string,
    id: string,
    signal?: AbortSignal,
    point?: IvyReflexService['point'],
  ) {
    this.beginTrace(id, text, point ? 'voice' : 'typed');
    const cancelled = () => {
      this.timeline.finish(id, 'cancelled', 'Request cancelled');
      return { handled: true, reply: '', outcome: 'cancelled' as const };
    };
    const fallback = (
      reason: string,
      outcome: 'unavailable' | 'hermes' = 'unavailable',
    ) => {
      this.lastRoute.set(`Hermes · ${reason}`);
      this.timeline.route(id, 'Terra');
      return { handled: false, reply: '', outcome };
    };
    if (!this.enabled()) return fallback('Reflex disabled');
    if (
      !this.invoke ||
      !text.trim() ||
      new TextEncoder().encode(text).length > 2048
    )
      return fallback('outside local scope', 'hermes');
    const revision = this.settingRevision;
    const epoch = this.epoch();
    const workspace = this.workspace();
    const shortcut = paneShortcut(text);
    if (!shortcut) {
      try {
        const route = decodeReflexRouting(
          await this.invoke('reflex_route', {
            request: {
              version: 1,
              input_id: id,
              text,
              mode: this.mode(),
              context: JSON.stringify({
                workspace: JSON.parse(workspace.context),
              }),
              history: this.controller.recentInteractions(),
              actions: workspace.actions.map(({ id, description }) => ({
                id,
                description,
              })),
            },
          }),
        );
        if (
          revision !== this.settingRevision ||
          epoch !== this.epoch() ||
          signal?.aborted
        )
          return cancelled();
        if (!route.local) return fallback('outside local scope', 'hermes');
      } catch {
        if (
          revision !== this.settingRevision ||
          epoch !== this.epoch() ||
          signal?.aborted
        ) {
          return cancelled();
        }
        return fallback('routing unavailable');
      }
      this.timeline.route(id, 'Reflex');
      if (this.available() === null)
        this.timeline.step(id, 'model-wait', 'Waiting for local readiness');
      await this.preparation;
      // A toggle during admission cancels this request instead of replaying it through Hermes.
      if (
        revision !== this.settingRevision ||
        epoch !== this.epoch() ||
        signal?.aborted
      )
        return cancelled();
      if (!this.invoke || !this.available())
        return fallback('Reflex unavailable');
    }
    this.timeline.route(id, 'Reflex');
    let workspaceCurrent = false;
    try {
      workspaceCurrent =
        workspace.context === this.workspace().context &&
        workspace.actions.every((action) => action.valid());
    } catch {
      /* A retired workspace cannot authorize a delayed request. */
    }
    if (!workspaceCurrent) {
      const reply = 'That changed while I was starting. Try again.';
      this.reply.set(reply);
      this.lastRoute.set('Reflex · rejected');
      this.timeline.finish(
        id,
        'rejected',
        'Workspace changed; request rejected',
      );
      return { handled: true, reply, outcome: 'rejected' as const };
    }
    if (this.busy()) {
      this.timeline.finish(id, 'rejected', 'Another local request is active');
      return {
        handled: true,
        reply: 'One thing at a time.',
        outcome: 'rejected' as const,
      };
    }
    this.busy.set(true);
    this.point = (stage) => {
      this.timeline.step(
        id,
        stage,
        {
          inference_start: 'Local reasoning',
          inference_complete: 'Local reasoning returned',
          action_dispatch: 'Action dispatched',
          action_complete: 'Executor returned',
        }[stage],
      );
      point?.(stage);
    };
    try {
      const outcome = await this.controller.run(text, id, this.mode(), signal);
      this.lastRoute.set(
        `${outcome.handled ? 'Reflex' : 'Hermes'} · ${outcome.outcome}`,
      );
      if (outcome.outcome === 'unavailable') this.available.set(false);
      if (outcome.handled)
        this.timeline.finish(
          id,
          outcome.outcome as Exclude<RequestTrace['outcome'], 'pending'>,
          (
            {
              confirmed: 'Action confirmed',
              clarify: 'Clarification requested',
              rejected: 'Action rejected',
              uncertain: 'Result uncertain',
              cancelled: 'Request cancelled',
            } as Partial<Record<string, string>>
          )[outcome.outcome] ?? 'Request finished',
        );
      else this.timeline.route(id, 'Terra');
      if (outcome.reply) this.reply.set(outcome.reply);
      return outcome;
    } finally {
      this.busy.set(false);
      this.point = undefined;
    }
  }

  private async environment(signal: AbortSignal): Promise<ReflexEnvironment> {
    const epoch = this.epoch();
    let media: ReflexMediaState | null = null;
    try {
      media = decodeReflexMediaState(
        await this.invoke?.('reflex_media_snapshot'),
      );
    } catch {
      /* Panes remain available without a media device. */
    }
    const workspace = this.workspace();
    const actions: LocalAction[] = [...workspace.actions];
    for (const mode of ['professional', 'playful'] as const)
      actions.push({
        id: `tone.${mode}`,
        description: `Set Ivy's conversational tone to ${mode}`,
        valid: () => !signal.aborted && this.epoch() === epoch,
        execute: () => {
          this.mode.set(mode);
          return 'confirmed';
        },
      });
    for (const action of media?.actions ?? []) {
      const snapshot = media;
      actions.push({
        id: `media.${action}`,
        description: mediaActionDescriptions[action as ReflexMediaAction],
        valid: () =>
          !signal.aborted && this.epoch() === epoch && snapshot !== null,
        execute: async (inputId) => {
          const cancel = () => {
            void this.invoke?.('reflex_cancel', { inputId }).catch(
              () => undefined,
            );
          };
          signal.addEventListener('abort', cancel, { once: true });
          try {
            return decodeReflexMediaResult(
              await this.invoke?.('reflex_media_execute', {
                request: {
                  version: 1,
                  input_id: inputId,
                  ticket: snapshot?.ticket,
                  action: action as ReflexMediaAction,
                },
              }),
            );
          } finally {
            signal.removeEventListener('abort', cancel);
          }
        },
      });
    }
    const state = media
      ? {
          player: media.player,
          title: media.title,
          playing: media.playing,
          volume: media.volume,
          muted: media.muted,
        }
      : null;
    return {
      epoch,
      context: JSON.stringify({
        media: state,
        workspace: JSON.parse(workspace.context),
      }),
      actions,
    };
  }
}
