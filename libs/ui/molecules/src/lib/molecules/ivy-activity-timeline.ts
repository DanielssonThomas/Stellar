export interface IvyActivityItem {
  readonly id: string;
  readonly label: string;
  readonly status: string;
  readonly running: boolean;
  readonly confirmed: boolean;
  readonly indicator: 'skill' | 'memory' | null;
}
export interface IvyActivityView {
  readonly visible: boolean;
  readonly leaving: boolean;
  readonly actions: readonly IvyActivityItem[];
}

export class IvyActivityTimeline {
  private key: string | null = null;
  private fallback?: ReturnType<typeof setTimeout>;
  private exit?: ReturnType<typeof setTimeout>;
  private view: IvyActivityView = {
    visible: false,
    leaving: false,
    actions: [],
  };
  constructor(private readonly publish: (view: IvyActivityView) => void) {}

  update(
    active: boolean,
    key: string | null,
    actions: readonly IvyActivityItem[],
  ) {
    if (active && key) {
      clearTimeout(this.exit);
      this.exit = undefined;
      if (key !== this.key) {
        clearTimeout(this.fallback);
        this.key = key;
        this.view = { ...this.view, leaving: false, actions: [] };
        this.fallback = setTimeout(() => {
          this.view = { ...this.view, visible: true };
          this.publish(this.view);
        }, 5000);
      }
      this.view = {
        ...this.view,
        leaving: false,
        actions: actions.slice(-12),
        visible: this.view.visible || actions.length > 0,
      };
    } else if (this.key !== null) {
      this.key = null;
      clearTimeout(this.fallback);
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
    clearTimeout(this.fallback);
    clearTimeout(this.exit);
  }
}
