import { DatePipe } from '@angular/common';
import { Component, computed, signal } from '@angular/core';
import { SkeletonAtom } from '@stellar/ui-atoms';
import clsx from 'clsx';

interface AgentProfile {
  role: string;
  id: string;
  mode: string;
  model: string;
  provider: string;
  sessionCount: number;
  sessionState: 'recorded' | 'none' | 'unavailable';
  lastActivity: string | null;
  usage: { inputTokens: number; outputTokens: number; apiCalls: number };
  events: { at: string | null; kind: 'session' | 'failure' }[];
  source: string;
}

interface GithubItem {
  number: number;
  title: string;
  url: string;
}

interface DashboardSnapshot {
  observedAt: string;
  agents: AgentProfile[];
  github: {
    state: 'live' | 'unavailable';
    issues: (GithubItem & {
      status: string;
      owner: string;
      blocked: boolean;
    })[];
    pulls: (GithubItem & { draft: boolean })[];
    source: string;
  };
}

@Component({
  imports: [DatePipe, SkeletonAtom],
  selector: 'stellar-root',
  templateUrl: './app.component.html',
  styleUrl: './app.component.css',
})
export class AppComponent {
  readonly roles = ['Architect', 'Foreman', 'Peon', 'Mira', 'Designer'];
  readonly view = signal<'operations' | 'studio'>('operations');
  readonly loading = signal(true);
  readonly error = signal(false);
  readonly snapshot = signal<DashboardSnapshot | null>(null);
  readonly blockedIssues = computed(
    () => this.snapshot()?.github.issues.filter((issue) => issue.blocked) ?? [],
  );
  readonly configuredProfiles = computed(
    () =>
      this.snapshot()?.agents.filter(
        (agent) =>
          !['Unavailable', 'Unconfigured', 'Unknown'].includes(agent.model) &&
          !['Unavailable', 'Unknown'].includes(agent.provider),
      ).length ?? 0,
  );
  readonly usageCoverage = computed(() => {
    const agents = this.snapshot()?.agents ?? [];
    const available = agents.filter(
      (agent) => agent.sessionState !== 'unavailable',
    ).length;
    if (available === 0) return 'unavailable';
    return available === agents.length ? 'complete' : 'partial';
  });
  readonly events = computed(() =>
    (
      this.snapshot()?.agents.flatMap((agent) =>
        agent.events.map((event) => ({
          ...event,
          role: agent.role,
          profile: agent.id,
        })),
      ) ?? []
    )
      .filter((event) => event.at)
      .sort((left, right) => (right.at ?? '').localeCompare(left.at ?? ''))
      .slice(0, 6),
  );
  readonly recentFailures = computed(
    () => this.events().filter((event) => event.kind === 'failure').length,
  );
  readonly totalCalls = computed(
    () =>
      this.snapshot()?.agents.reduce(
        (sum, agent) => sum + agent.usage.apiCalls,
        0,
      ) ?? 0,
  );
  readonly totalTokens = computed(
    () =>
      this.snapshot()?.agents.reduce(
        (sum, agent) =>
          sum + agent.usage.inputTokens + agent.usage.outputTokens,
        0,
      ) ?? 0,
  );

  constructor() {
    void this.refresh();
  }

  async refresh(): Promise<void> {
    this.loading.set(true);
    this.error.set(false);
    try {
      const response = await fetch('http://127.0.0.1:4211/api/status');
      if (!response.ok) throw new Error('Status unavailable');
      this.snapshot.set((await response.json()) as DashboardSnapshot);
    } catch {
      this.error.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  profilesFor(role: string): AgentProfile[] {
    return this.snapshot()?.agents.filter((agent) => agent.role === role) ?? [];
  }

  stateClasses(sessionCount: number): string {
    return clsx(
      'rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider',
      sessionCount > 0
        ? 'border-stellar-good/30 bg-stellar-good/10 text-stellar-good'
        : 'border-stellar-line bg-stellar-panel-raised text-stellar-muted',
    );
  }
}
