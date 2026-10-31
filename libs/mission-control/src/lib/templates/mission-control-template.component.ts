import { DatePipe } from '@angular/common';
import {
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  OnDestroy,
  OnInit,
  signal,
  ViewChild,
} from '@angular/core';
import { SkeletonAtom } from '@stellar/ui-atoms';
import { LiveWorkplaceOrganism } from '@stellar/ui-organisms';
import {
  DashboardStatusService,
  LiveTelemetryService,
  type LiveEvent,
  type LiveProject,
  type ProductionStageState,
} from '@stellar/service-dashboard-status';
import clsx from 'clsx';

type InspectedEvent = LiveEvent & {
  agentId: string;
  agentName: string;
  project: LiveProject;
};

@Component({
  selector: 'stellar-mission-control-template',
  standalone: true,
  imports: [DatePipe, SkeletonAtom, LiveWorkplaceOrganism],
  templateUrl: './mission-control-template.component.html',
  styleUrl: './mission-control-template.component.css',
  host: {
    '[attr.aria-busy]':
      "view() === 'live' ? !live.snapshot() && live.transport() === 'connecting' : status.loading()",
  },
})
export class MissionControlTemplate implements OnInit, OnDestroy {
  readonly status = inject(DashboardStatusService);
  readonly live = inject(LiveTelemetryService);
  readonly view = signal<'live' | 'operations' | 'studio'>('live');
  readonly projectFilter = signal<'all' | LiveProject>('all');
  readonly selectedAgentId = signal<string | null>(null);
  readonly selectedEventId = signal<string | null>(null);
  readonly pinnedEvent = signal<InspectedEvent | null>(null);
  readonly followTimeline = signal(true);
  readonly inspectorExpanded = signal(true);
  readonly filteredLiveAgents = computed(() =>
    this.live
      .agents()
      .filter(
        (agent) =>
          this.projectFilter() === 'all' ||
          agent.project === this.projectFilter(),
      ),
  );
  readonly selectedLiveAgent = computed(() => {
    const agents = this.filteredLiveAgents();
    return (
      agents.find((agent) => agent.id === this.selectedAgentId()) ??
      agents.find((agent) => agent.state === 'running') ??
      agents[0] ??
      null
    );
  });
  readonly liveTimeline = computed(() =>
    this.filteredLiveAgents()
      .flatMap((agent) =>
        agent.events
          .filter((event) => event.at)
          .map((event) => ({
            ...event,
            agentId: agent.id,
            agentName: agent.name,
            project: agent.project,
          })),
      )
      .sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''))
      .slice(-120),
  );
  readonly selectedLiveEvent = computed(
    () =>
      this.liveTimeline().find(
        (event) => event.id === this.selectedEventId(),
      ) ?? this.pinnedEvent(),
  );
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
  @ViewChild('timelineScroll')
  private timelineScroll?: ElementRef<HTMLDivElement>;
  constructor() {
    effect(() => {
      const lastId = this.liveTimeline().at(-1)?.id;
      if (lastId && this.followTimeline() && !this.selectedEventId())
        setTimeout(() => {
          const element = this.timelineScroll?.nativeElement;
          if (element && this.followTimeline())
            element.scrollTop = element.scrollHeight;
        });
    });
  }

  ngOnInit(): void {
    this.live.start();
    void this.status.refresh();
    this.timer = setInterval(() => {
      this.now.set(Date.now());
      void this.status.refresh();
    }, 30_000);
  }

  ngOnDestroy(): void {
    this.live.stop();
    if (this.timer) clearInterval(this.timer);
  }

  selectLiveAgent(id: string): void {
    this.selectedAgentId.set(id);
    this.selectedEventId.set(null);
    this.pinnedEvent.set(null);
    this.followTimeline.set(true);
  }

  selectLiveEvent(id: string | null, agentId: string): void {
    this.selectedAgentId.set(agentId);
    this.selectedEventId.set(id);
    this.pinnedEvent.set(
      this.liveTimeline().find((event) => event.id === id) ?? null,
    );
    this.followTimeline.set(false);
  }

  onTimelineScroll(event: Event): void {
    const element = event.target as HTMLDivElement;
    this.followTimeline.set(
      element.scrollHeight - element.scrollTop - element.clientHeight < 28,
    );
  }

  filterLive(project: 'all' | LiveProject): void {
    this.projectFilter.set(project);
    this.selectedEventId.set(null);
    this.pinnedEvent.set(null);
    this.followTimeline.set(true);
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

  tabClass(tab: 'live' | 'operations' | 'studio'): string {
    return clsx('tab', this.view() === tab && 'selected');
  }

  stageClass(stage?: ProductionStageState): string {
    return clsx('stage', stage ?? 'unknown');
  }
}
