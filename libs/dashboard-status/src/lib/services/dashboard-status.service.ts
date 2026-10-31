import { Injectable, signal } from '@angular/core';

export type ActivityState =
  | 'running'
  | 'queued'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'idle'
  | 'unknown';

export type ProductionStageState = 'done' | 'current' | 'pending' | 'unknown';

export interface DashboardAgent {
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

export interface DashboardIssue {
  number: number;
  title: string;
  url: string;
  status: string;
  owner: string;
  blocked: boolean;
  updatedAt?: string | null;
}

export interface DashboardCharacter {
  state: 'observed' | 'unavailable';
  id: string;
  source: string;
  reason?: string;
  assignedAgent?: string;
  activity?: ActivityState;
  designerSessionCount?: number | null;
  phase?: string;
  workflow?: string;
  contractApproved?: boolean;
  referenceAvailable?: boolean;
  pipeline?: {
    reference: ProductionStageState;
    bodyFace: ProductionStageState;
    vroidValidation: ProductionStageState;
    blender: ProductionStageState;
    finalReview: ProductionStageState;
  };
  nextAction?: string;
  outstandingCount?: number;
  vroid?: {
    achieved: number;
    total: number;
    sourceRecorded: boolean;
    exportRecorded: boolean;
  };
  blender?: { launchAllowed: boolean; sessionRecorded: boolean };
  handoff?: string;
  blocker?: string;
  outstanding?: { id: string; status: string }[];
  latestImage?: string | null;
  latestImageLabel?: string | null;
  validation?: string;
  technicalValidation?: string;
  lastVerifiedAt?: string;
}

export interface DashboardSnapshot {
  observedAt: string;
  agents: DashboardAgent[];
  github: {
    state: 'live' | 'stale' | 'unavailable';
    issues: DashboardIssue[];
    pulls: {
      number: number;
      title: string;
      url: string;
      draft: boolean;
      updatedAt?: string | null;
    }[];
    recentCompleted?: {
      number: number;
      title: string;
      url: string;
      updatedAt?: string | null;
    }[];
    source: string;
    observedAt?: string;
    complete?: boolean;
  };
  characters?: DashboardCharacter[];
}

@Injectable({ providedIn: 'root' })
export class DashboardStatusService {
  readonly snapshot = signal<DashboardSnapshot | null>(null);
  readonly loading = signal(true);
  readonly error = signal(false);
  readonly lastSuccessfulFetch = signal<string | null>(null);

  async refresh(): Promise<void> {
    if (!this.snapshot()) this.loading.set(true);
    try {
      const response = await fetch('http://127.0.0.1:4211/api/status', {
        cache: 'no-store',
      });
      if (!response.ok) throw new Error('Status unavailable');
      this.snapshot.set((await response.json()) as DashboardSnapshot);
      this.lastSuccessfulFetch.set(new Date().toISOString());
      this.error.set(false);
    } catch {
      this.error.set(true);
    } finally {
      this.loading.set(false);
    }
  }
}
