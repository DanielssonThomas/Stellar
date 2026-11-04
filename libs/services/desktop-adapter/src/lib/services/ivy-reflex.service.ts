import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import {
  decodeReflexReply,
  decodeReflexMediaState,
  decodeReflexMediaResult,
  type ReflexMediaAction,
  type ReflexMediaState,
  type ReflexMode,
} from '@stellar/desktop-contracts';
import type { LocalAction } from '../reflex/action-registry';
import { mediaActionDescriptions } from '../reflex/media-actions';
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
  readonly localAvailable = !!this.invoke;
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
    environment: (signal) => this.environment(signal),
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
    inject(DestroyRef).onDestroy(() => this.controller.cancel());
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
    if (!this.invoke)
      return { handled: false, reply: '', outcome: 'unavailable' as const };
    if (this.busy())
      return {
        handled: true,
        reply: 'One thing at a time.',
        outcome: 'rejected' as const,
      };
    this.busy.set(true);
    this.point = point;
    try {
      const outcome = await this.controller.run(text, id, this.mode(), signal);
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
