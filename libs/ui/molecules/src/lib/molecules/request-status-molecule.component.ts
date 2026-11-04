import {
  Component,
  computed,
  effect,
  input,
  output,
  signal,
} from '@angular/core';
import { SkeletonAtom } from '@stellar/ui-atoms';
import clsx from 'clsx';

export interface RequestStatusEntry {
  readonly id: string;
  readonly sequence: number;
  readonly preview: string;
  readonly source: string;
  readonly route: string;
  readonly outcome: string;
  readonly started: number;
  readonly speaking: boolean;
  readonly steps: readonly {
    readonly key: string;
    readonly label: string;
    readonly elapsed: number;
  }[];
}

@Component({
  selector: 'stellar-request-status-molecule',
  standalone: true,
  imports: [SkeletonAtom],
  templateUrl: './request-status-molecule.component.html',
  styleUrl: './request-status-molecule.component.css',
  host: { '[attr.aria-busy]': 'loading()' },
})
export class RequestStatusMolecule {
  readonly loading = input(false);
  readonly requests = input<readonly RequestStatusEntry[]>([]);
  readonly localStatus = input('Unavailable');
  readonly cloudStatus = input('unavailable');
  readonly cloudLabel = input('Terra');
  readonly voiceStatus = input('Local voice idle');
  readonly reducedMotion = input(false);
  readonly dismiss = output<void>();
  readonly latest = computed(() => this.requests().at(-1));
  readonly previous = computed(() => this.requests().slice(-3, -1).reverse());
  readonly steps = computed(() => this.latest()?.steps.slice(-8) ?? []);
  readonly active = computed(
    () => this.latest()?.outcome === 'pending' || !!this.latest()?.speaking,
  );
  private readonly now = signal(performance.now());
  readonly elapsed = computed(() => {
    const latest = this.latest();
    return latest
      ? this.active()
        ? Math.max(0, this.now() - latest.started)
        : (latest.steps.at(-1)?.elapsed ?? 0)
      : 0;
  });
  readonly classes = computed(() =>
    clsx('request-status', {
      'is-active': this.active(),
      'motion-reduced': this.reducedMotion(),
    }),
  );
  constructor() {
    effect((cleanup) => {
      if (!this.active()) return;
      this.now.set(performance.now());
      const timer = setInterval(() => this.now.set(performance.now()), 200);
      cleanup(() => clearInterval(timer));
    });
  }
  duration(ms: number) {
    return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
  }
}
