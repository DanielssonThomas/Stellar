import { DatePipe } from '@angular/common';
import {
  Component,
  computed,
  inject,
  OnDestroy,
  OnInit,
  signal,
} from '@angular/core';
import { SkeletonAtom } from '@stellar/ui-atoms';
import {
  DashboardStatusService,
  type ProductionStageState,
} from '@stellar/service-dashboard-status';
import clsx from 'clsx';

@Component({
  selector: 'stellar-mission-control-template',
  standalone: true,
  imports: [DatePipe, SkeletonAtom],
  templateUrl: './mission-control-template.component.html',
  styleUrl: './mission-control-template.component.css',
  host: { '[attr.aria-busy]': 'status.loading()' },
})
export class MissionControlTemplate implements OnInit, OnDestroy {
  readonly status = inject(DashboardStatusService);
  readonly view = signal<'operations' | 'studio'>('operations');
  readonly now = signal(Date.now());
  readonly snapshot = this.status.snapshot;
  readonly issues = computed(() => this.snapshot()?.github.issues ?? []);
  readonly inProgress = computed(() =>
    this.issues().filter((issue) => issue.status === 'in-progress'),
  );
  readonly queued = computed(() =>
    this.issues().filter((issue) => issue.status === 'ready'),
  );
  readonly blocked = computed(() =>
    this.issues().filter((issue) => issue.blocked),
  );
  readonly review = computed(() =>
    this.issues().filter((issue) => issue.status === 'review'),
  );
  readonly completed = computed(
    () => this.snapshot()?.github.recentCompleted ?? [],
  );
  readonly characters = computed(() => this.snapshot()?.characters ?? []);
  readonly events = computed(
    () =>
      this.snapshot()
        ?.agents.flatMap((agent) =>
          agent.events
            .filter((event) => event.at)
            .map((event) => ({
              ...event,
              role: agent.role,
              profile: agent.id,
            })),
        )
        .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
        .slice(0, 5) ?? [],
  );
  readonly ageSeconds = computed(() => {
    const at = this.snapshot()?.observedAt;
    return at
      ? Math.max(0, Math.round((this.now() - Date.parse(at)) / 1000))
      : null;
  });
  readonly imageRevision = computed(() => {
    const observedAt = this.snapshot()?.observedAt;
    return observedAt ? Date.parse(observedAt) : 0;
  });
  readonly stale = computed(
    () =>
      this.status.error() ||
      (this.ageSeconds() ?? 9999) > 90 ||
      this.snapshot()?.github.state !== 'live' ||
      this.characters().some((character) => character.state === 'unavailable'),
  );
  private timer?: ReturnType<typeof setInterval>;

  ngOnInit(): void {
    void this.status.refresh();
    this.timer = setInterval(() => {
      this.now.set(Date.now());
      void this.status.refresh();
    }, 30_000);
  }

  ngOnDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  stateForIssue(status: string): string {
    if (status === 'ready') return 'queued';
    if (status === 'blocked') return 'blocked';
    if (status === 'review') return 'review';
    if (status === 'done') return 'completed';
    return status === 'in-progress'
      ? 'in progress · execution unverified'
      : 'unknown';
  }

  tabClass(tab: 'operations' | 'studio'): string {
    return clsx('tab', this.view() === tab && 'selected');
  }

  stageClass(stage?: ProductionStageState): string {
    return clsx('stage', stage ?? 'unknown');
  }
}
