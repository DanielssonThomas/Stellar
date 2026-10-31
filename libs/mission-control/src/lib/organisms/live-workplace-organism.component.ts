import { Component, computed, input, output } from '@angular/core';
import { SkeletonAtom } from '@stellar/ui-atoms';
import clsx from 'clsx';
export interface WorkplaceAgent {
  id: string;
  name: string;
  state: 'running' | 'completed' | 'failed' | 'disconnected' | 'unknown';
  activity: string | null;
}

type Area = {
  id: 'code' | 'review' | 'creative' | 'codex';
  label: string;
  caption: string;
  icon: string;
  agents: readonly string[];
};

@Component({
  selector: 'stellar-live-workplace-organism',
  standalone: true,
  imports: [SkeletonAtom],
  templateUrl: './live-workplace-organism.component.html',
  styleUrl: './live-workplace-organism.component.css',
  host: { '[attr.aria-busy]': 'loading()' },
})
export class LiveWorkplaceOrganism {
  readonly loading = input(false);
  readonly agents = input<WorkplaceAgent[]>([]);
  readonly selectedId = input<string | null>(null);
  readonly selectAgent = output<string>();
  readonly runningCount = computed(
    () => this.agents().filter((agent) => agent.state === 'running').length,
  );
  readonly areas: readonly Area[] = [
    {
      id: 'codex',
      label: 'Codex Corner',
      caption: 'Desktop sessions',
      icon: '✳',
      agents: [],
    },
    {
      id: 'code',
      label: 'Code Bay',
      caption: 'Engineering workstations',
      icon: '</>',
      agents: ['peon', 'peon-cloud', 'mira'],
    },
    {
      id: 'review',
      label: 'Review Deck',
      caption: 'Planning and review',
      icon: '◇',
      agents: ['architect', 'architect-cloud', 'foreman', 'foreman-cloud'],
    },
    {
      id: 'creative',
      label: 'Creative Studio',
      caption: 'Character and asset design',
      icon: '✦',
      agents: ['designer', 'art-director'],
    },
  ];

  agentsFor(area: Area): WorkplaceAgent[] {
    return this.agents().filter((agent) =>
      area.id === 'codex'
        ? agent.id.startsWith('codex-')
        : area.agents.includes(agent.id),
    );
  }

  countClass(): string {
    return clsx(
      'live-count',
      this.runningCount() > 0 && 'has-running text-stellar-good',
    );
  }

  stationClass(agent: WorkplaceAgent): string {
    return clsx(
      'station',
      `tone-${this.tone(agent)}`,
      agent.state === 'running' && 'is-running',
      agent.id === this.selectedId() && 'is-selected',
    );
  }

  statusClass(agent: WorkplaceAgent): string {
    return clsx('station-status', agent.state === 'running' && 'active');
  }

  avatarClass(agent: WorkplaceAgent): string {
    return clsx('avatar', agent.state === 'running' && 'working');
  }

  tone(agent: WorkplaceAgent): string {
    if (agent.id.startsWith('codex-')) return 'lime';
    if (agent.id.startsWith('architect')) return 'violet';
    if (agent.id.startsWith('foreman')) return 'amber';
    if (agent.id.startsWith('peon')) return 'cyan';
    if (agent.id === 'mira') return 'lime';
    if (agent.id === 'designer') return 'pink';
    return 'blue';
  }

  stateText(state: WorkplaceAgent['state']): string {
    if (state === 'running') return 'Recently observed turn in progress';
    if (state === 'completed') return 'Session completed';
    if (state === 'failed') return 'Session failed';
    if (state === 'disconnected') return 'Source disconnected';
    return 'Execution unknown';
  }
}
