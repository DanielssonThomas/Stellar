export interface RequestStep {
  readonly key: string;
  readonly label: string;
  readonly elapsed: number;
}
export interface RequestTrace {
  readonly id: string;
  readonly sequence: number;
  readonly preview: string;
  readonly source: 'typed' | 'voice';
  readonly route: 'Routing' | 'Reflex' | 'Terra' | 'Sol';
  readonly outcome:
    | 'pending'
    | 'confirmed'
    | 'clarify'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'uncertain'
    | 'unavailable'
    | 'rejected';
  readonly started: number;
  readonly steps: readonly RequestStep[];
  readonly speaking: boolean;
}

/** Ephemeral, bounded UI observations. Never alters request execution or exports content. */
export class RequestTimeline {
  private items: RequestTrace[] = [];
  private sequence = 0;
  constructor(
    private readonly publish: (items: readonly RequestTrace[]) => void,
    private readonly clock = () => performance.now(),
  ) {}
  clear() {
    this.items = [];
    this.sequence = 0;
    this.emit();
  }
  begin(id: string, text: string, source: RequestTrace['source']) {
    if (this.items.some((item) => item.id === id)) return;
    const item: RequestTrace = {
      id,
      sequence: ++this.sequence,
      preview: [...text.replace(/\s+/g, ' ').trim()].slice(0, 120).join(''),
      source,
      route: 'Routing',
      outcome: 'pending',
      started: this.now(),
      speaking: false,
      steps: [
        {
          key: 'received',
          label:
            source === 'voice' ? 'Transcript received' : 'Request received',
          elapsed: 0,
        },
      ],
    };
    this.items = [...this.items, item].slice(-6);
    this.emit();
  }
  route(id: string, route: RequestTrace['route']) {
    this.update(id, (item) =>
      item.outcome === 'pending'
        ? {
            ...this.point(item, `route-${route}`, `Routed to ${route}`),
            route,
          }
        : item,
    );
  }
  step(id: string, key: string, label: string) {
    this.update(id, (item) =>
      item.outcome === 'pending' ? this.point(item, key, label) : item,
    );
  }
  finish(
    id: string,
    outcome: Exclude<RequestTrace['outcome'], 'pending'>,
    label: string,
  ) {
    this.update(id, (item) =>
      item.outcome === 'pending'
        ? {
            ...this.point(item, 'result', label),
            outcome,
            speaking:
              ['confirmed', 'clarify', 'completed'].includes(outcome) &&
              item.speaking,
          }
        : item,
    );
  }
  reconcile(
    id: string,
    outcome: 'completed' | 'failed' | 'cancelled',
    label: string,
  ) {
    this.update(id, (item) =>
      item.outcome === 'uncertain' && ['Terra', 'Sol'].includes(item.route)
        ? { ...this.point(item, 'reconciled', label), outcome, speaking: false }
        : item,
    );
  }
  speech(
    id: string,
    stage: 'synthesis' | 'playing' | 'completed' | 'failed' | 'cancelled',
  ) {
    this.update(id, (item) =>
      item.outcome !== 'cancelled' &&
      !item.steps.some((step) =>
        ['speech-completed', 'speech-failed', 'speech-cancelled'].includes(
          step.key,
        ),
      )
        ? {
            ...this.point(
              item,
              `speech-${stage}`,
              {
                synthesis: 'Voice synthesis',
                playing: 'Voice playing',
                completed: 'Voice complete',
                failed: 'Voice unavailable',
                cancelled: 'Voice stopped',
              }[stage],
            ),
            speaking: stage === 'synthesis' || stage === 'playing',
          }
        : item,
    );
  }
  private point(item: RequestTrace, key: string, label: string): RequestTrace {
    if (item.steps.some((step) => step.key === key)) return item;
    return {
      ...item,
      steps: [
        ...item.steps,
        {
          key,
          label: [...label].slice(0, 80).join(''),
          elapsed: Math.max(
            item.steps.at(-1)?.elapsed ?? 0,
            this.now() - item.started,
          ),
        },
      ].slice(-16),
    };
  }
  private now() {
    try {
      const value = this.clock();
      return Number.isFinite(value) ? value : 0;
    } catch {
      return 0;
    }
  }
  private update(id: string, change: (item: RequestTrace) => RequestTrace) {
    const index = this.items.findIndex((item) => item.id === id);
    if (index < 0) return;
    const next = change(this.items[index]);
    if (next === this.items[index]) return;
    this.items = this.items.map((item, i) => (i === index ? next : item));
    this.emit();
  }
  private emit() {
    try {
      this.publish(
        this.items.map((item) => ({
          ...item,
          steps: item.steps.map((step) => ({ ...step })),
        })),
      );
    } catch {
      /* Observation must never change action authority or cause a retry. */
    }
  }
}
