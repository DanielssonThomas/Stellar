import {
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { SkeletonAtom } from '@stellar/ui-atoms';
import clsx from 'clsx';
import {
  IvyActivityTimeline,
  type IvyActivityItem,
  type IvyActivityView,
} from './ivy-activity-timeline';
export type { IvyActivityItem } from './ivy-activity-timeline';

@Component({
  selector: 'stellar-ivy-activity-molecule',
  standalone: true,
  imports: [SkeletonAtom],
  templateUrl: './ivy-activity-molecule.component.html',
  styleUrl: './ivy-activity-molecule.component.css',
  host: {
    '[attr.aria-busy]': 'loading()',
    '[style.--emblem-x.px]': 'emblem().x',
    '[style.--emblem-y.px]': 'emblem().y',
    '[style.--emblem-size.px]': 'emblem().width',
  },
})
export class IvyActivityMolecule {
  readonly loading = input(false);
  readonly active = input(false);
  readonly preparing = input(false);
  readonly turnId = input<string | null>(null);
  readonly actions = input<readonly IvyActivityItem[]>([]);
  readonly suppressed = input(false);
  readonly reducedMotion = input(false);
  readonly emblem = input({ x: 0, y: 0, width: 280, height: 280 });
  readonly view = signal<IvyActivityView>({
    visible: false,
    leaving: false,
    actions: [],
  });
  private readonly timeline = new IvyActivityTimeline((view) =>
    this.view.set(view),
  );
  readonly classes = computed(() =>
    clsx('activity-overlay', {
      leaving: this.view().leaving,
      'motion-reduced': this.reducedMotion(),
    }),
  );
  readonly indicator = computed(() => {
    const rows = this.view().actions;
    return (
      [...rows].reverse().find((row) => row.indicator && row.running) ??
      [...rows].reverse().find((row) => row.indicator && row.confirmed)
    );
  });
  readonly indicators = computed(() => {
    const rows = [...this.view().actions].reverse();
    return (['skill', 'memory'] as const).flatMap((kind) => {
      const item =
        rows.find((row) => row.indicator === kind && row.running) ??
        rows.find((row) => row.indicator === kind && row.confirmed);
      return item ? [item] : [];
    });
  });
  readonly description = computed(() => {
    const indicator = this.indicator();
    if (indicator?.indicator === 'skill')
      return indicator.running
        ? indicator.label === 'Create skill'
          ? 'Creating a skill'
          : 'Updating a skill'
        : 'Skill update confirmed';
    if (indicator?.indicator === 'memory')
      return indicator.running ? 'Updating memory' : 'Memory update confirmed';
    return this.view().actions.some((row) => row.running)
      ? 'Working with tools'
      : this.preparing()
        ? 'Preparing request'
        : 'Working';
  });
  constructor() {
    effect(() =>
      this.timeline.update(this.active(), this.turnId(), this.actions()),
    );
    inject(DestroyRef).onDestroy(() => this.timeline.dispose());
  }
}
