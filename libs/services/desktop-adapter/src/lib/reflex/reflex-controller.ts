import type {
  ReflexPlan,
  ReflexRequest,
  ReflexMode,
} from '@stellar/desktop-contracts';
import { LocalActionRegistry, type LocalAction } from './action-registry';
import { ReflexLatency, type ReflexTimingStage } from './reflex-latency';

export interface ReflexEnvironment {
  readonly epoch: string;
  readonly context: string;
  readonly actions: readonly LocalAction[];
}
export interface ReflexOutcome {
  readonly handled: boolean;
  readonly reply: string;
  readonly outcome:
    | 'confirmed'
    | 'clarify'
    | 'rejected'
    | 'uncertain'
    | 'cancelled'
    | 'hermes'
    | 'unavailable';
}
export interface ReflexEvent {
  readonly action: string;
  readonly target: string;
  readonly outcome: 'confirmed' | 'uncertain';
  readonly reply: string;
}
export interface ReflexPorts {
  readonly environment: (signal: AbortSignal) => Promise<ReflexEnvironment>;
  readonly currentEpoch: () => string;
  readonly infer: (
    request: ReflexRequest,
    signal: AbortSignal,
  ) => Promise<ReflexPlan | null>;
  readonly point?: (
    stage:
      | 'inference_start'
      | 'inference_complete'
      | 'action_dispatch'
      | 'action_complete',
  ) => void;
}

export class ReflexController {
  private active?: AbortController;
  private readonly seen = new Set<string>();
  private history: ReflexEvent[] = [];
  private interactions: string[] = [];
  private historyEpoch = '';
  private pending: ReflexEvent[] = [];
  constructor(private readonly ports: ReflexPorts) {}

  cancel() {
    this.active?.abort();
  }
  clear() {
    this.cancel();
    this.history = [];
    this.interactions = [];
    this.pending = [];
    this.seen.clear();
  }
  events(): readonly ReflexEvent[] {
    if (this.historyEpoch !== this.ports.currentEpoch()) {
      this.history = [];
      this.interactions = [];
      this.pending = [];
    }
    return this.pending.map((e) => ({ ...e }));
  }
  acknowledgeEvents(events: readonly ReflexEvent[]) {
    if (
      events.every(
        (v, i) =>
          this.pending[i] === v ||
          JSON.stringify(this.pending[i]) === JSON.stringify(v),
      )
    )
      this.pending.splice(0, events.length);
  }

  async run(
    text: string,
    inputId: string,
    mode: ReflexMode,
    parent?: AbortSignal,
  ): Promise<ReflexOutcome> {
    const latency = new ReflexLatency();
    const point = (stage: ReflexTimingStage) => {
      try {
        latency.point(stage);
        this.ports.point?.(stage);
      } catch {
        /* Diagnostics cannot change dispatch authority. */
      }
    };
    const result = (
      outcome: ReflexOutcome['outcome'],
      reply = '',
    ): ReflexOutcome => {
      try {
        latency.finish(outcome);
      } catch {
        /* A confirmed effect cannot become a retry because diagnostics failed. */
      }
      return {
        handled: !['hermes', 'unavailable'].includes(outcome),
        outcome,
        reply,
      };
    };
    if (this.active || this.seen.has(inputId))
      return result('rejected', 'One thing at a time.');
    if (!text.trim() || new TextEncoder().encode(text).length > 2048)
      return result('hermes');
    const epoch = this.ports.currentEpoch();
    if (epoch !== this.historyEpoch) {
      this.history = [];
      this.interactions = [];
      this.pending = [];
      this.seen.clear();
      this.historyEpoch = epoch;
    }
    const controller = new AbortController();
    this.active = controller;
    this.seen.add(inputId);
    if (this.seen.size > 256)
      this.seen.delete(this.seen.values().next().value as string);
    const abort = () => controller.abort();
    parent?.addEventListener('abort', abort, { once: true });
    if (parent?.aborted) abort();
    const current = () =>
      !controller.signal.aborted && epoch === this.ports.currentEpoch();
    let actionMayHaveRun = false;
    try {
      const environment = await this.ports.environment(controller.signal);
      if (!current() || environment.epoch !== epoch) return result('cancelled');
      const registry = new LocalActionRegistry(environment.actions);
      point('inference_start');
      const plan = await this.ports.infer(
        {
          version: 1,
          input_id: inputId,
          text,
          mode,
          context: environment.context,
          history: this.interactions,
          actions: registry.choices(),
        },
        controller.signal,
      );
      point('inference_complete');
      if (!current()) return result('cancelled');
      if (!plan) return result('unavailable');
      if (plan.route === 'hermes') return result('hermes');
      const remember = (reply: string) => {
        const user = [...text].slice(0, 70).join('');
        this.interactions = [
          ...this.interactions,
          JSON.stringify({ user, ivy: reply }),
        ].slice(-3);
      };
      if (plan.route === 'clarify') {
        remember(plan.reply);
        return result('clarify', plan.reply);
      }
      if (!plan.action_id)
        return result('rejected', 'I couldn’t verify that action.');
      point('action_dispatch');
      actionMayHaveRun = true;
      const outcome = await registry.dispatch(
        plan.action_id,
        inputId,
        controller.signal,
      );
      point('action_complete');
      const reply =
        outcome === 'confirmed'
          ? plan.reply
          : outcome === 'uncertain'
            ? 'I couldn’t confirm that. Check before trying again.'
            : 'That changed before I could act. Try again.';
      if (outcome !== 'rejected') {
        const event = {
          action: plan.action_id,
          target: registry.describe(plan.action_id),
          outcome,
          reply,
        };
        this.history = [...this.history, event].slice(-6);
        this.pending = [...this.pending, event].slice(-6);
      }
      remember(reply);
      // An effect already dispatched must never be retried through Hermes on cancellation.
      return current() ? result(outcome, reply) : result('cancelled');
    } catch {
      if (actionMayHaveRun)
        return result(
          'uncertain',
          'I couldn’t confirm that. Check before trying again.',
        );
      return current() ? result('unavailable') : result('cancelled');
    } finally {
      parent?.removeEventListener('abort', abort);
      if (this.active === controller) this.active = undefined;
    }
  }
}
