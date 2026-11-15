import type { IvyActivityProvider } from '@stellar/desktop-contracts';

export interface IvyActivityItem {
  readonly id: string;
  readonly label: string;
  readonly status: string;
  readonly running: boolean;
  readonly confirmed: boolean;
  readonly indicator: 'skill' | 'memory' | null;
  readonly provider?: IvyActivityProvider;
  readonly elapsedMs?: number;
}
export interface IvyActivityView {
  readonly visible: boolean;
  readonly leaving: boolean;
  readonly actions: readonly IvyActivityItem[];
  readonly elapsedMs?: number;
}

export class IvyActivityTimeline {
  private key: string | null = null;
  private tick?: ReturnType<typeof setTimeout>;
  private exit?: ReturnType<typeof setTimeout>;
  private started = 0;
  private readonly observed = new Map<
    string,
    { started: number; ended?: number }
  >();
  private view: IvyActivityView = {
    visible: false,
    leaving: false,
    actions: [],
  };
  constructor(
    private readonly publish: (view: IvyActivityView) => void,
    private readonly clock = () => performance.now(),
  ) {}

  update(
    active: boolean,
    key: string | null,
    actions: readonly IvyActivityItem[],
  ) {
    if (active && key) {
      clearTimeout(this.exit);
      this.exit = undefined;
      if (key !== this.key) {
        clearTimeout(this.tick);
        this.tick = undefined;
        this.key = key;
        this.started = this.clock();
        this.observed.clear();
        this.view = { visible: true, leaving: false, actions: [] };
      }
      const now = this.clock();
      for (const row of actions) {
        const timing = this.observed.get(row.id) ?? { started: now };
        if (!row.running && timing.ended === undefined) timing.ended = now;
        this.observed.set(row.id, timing);
      }
      const retained = actions.slice(-12);
      for (const id of this.observed.keys())
        if (!retained.some((row) => row.id === id)) this.observed.delete(id);
      this.view = {
        ...this.view,
        leaving: false,
        actions: retained,
        visible: true,
      };
      this.refresh();
      if (!this.tick) this.schedule();
    } else if (this.key !== null) {
      this.key = null;
      clearTimeout(this.tick);
      this.tick = undefined;
      if (this.view.visible) {
        this.view = { ...this.view, leaving: true };
        this.exit = setTimeout(() => {
          this.view = { visible: false, leaving: false, actions: [] };
          this.publish(this.view);
        }, 240);
      }
    }
    this.publish(this.view);
  }
  dispose() {
    clearTimeout(this.tick);
    clearTimeout(this.exit);
  }
  private refresh() {
    const now = this.clock();
    this.view = {
      ...this.view,
      elapsedMs: Math.max(0, now - this.started),
      actions: this.view.actions.map((row) => {
        const timing = this.observed.get(row.id);
        return {
          ...row,
          elapsedMs: timing
            ? Math.max(0, (timing.ended ?? now) - timing.started)
            : 0,
        };
      }),
    };
  }
  private schedule() {
    this.tick = setTimeout(() => {
      this.tick = undefined;
      if (!this.key) return;
      this.refresh();
      this.publish(this.view);
      this.schedule();
    }, 1000);
  }
}
