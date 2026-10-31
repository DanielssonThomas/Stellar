import { computed, Injectable, signal } from '@angular/core';

export type LiveProject = 'stellar' | 'stellar-design';
export type LiveAgentState =
  | 'running'
  | 'completed'
  | 'failed'
  | 'disconnected'
  | 'unknown';

export interface LiveEvent {
  id: string | null;
  at: string | null;
  kind: 'tool' | 'failure' | 'completion';
  label: string;
}

export interface LiveAgent {
  id: string;
  name: string;
  project: LiveProject;
  state: LiveAgentState;
  sessionId: string | null;
  task: string | null;
  activity: string | null;
  tool: string | null;
  model: string | null;
  provider: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
  startedAt: string | null;
  lastObservedAt: string | null;
  source: {
    kind: string;
    health: 'available' | 'unavailable';
    observedAt: string;
  };
  events: LiveEvent[];
}

export interface LiveSnapshot {
  schemaVersion: 1;
  sequence: number;
  observedAt: string;
  agents: LiveAgent[];
}

export type LiveTransport =
  | 'connecting'
  | 'streaming'
  | 'polling'
  | 'reconnecting'
  | 'unavailable';

const baseUrl = 'http://127.0.0.1:4212';
const states = new Set<LiveAgentState>([
  'running',
  'completed',
  'failed',
  'disconnected',
  'unknown',
]);
const projects = new Set<LiveProject>(['stellar', 'stellar-design']);

function parseSnapshot(value: unknown): LiveSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<LiveSnapshot>;
  if (
    candidate.schemaVersion !== 1 ||
    !Number.isSafeInteger(candidate.sequence) ||
    !candidate.observedAt ||
    !Number.isFinite(Date.parse(candidate.observedAt)) ||
    !Array.isArray(candidate.agents) ||
    candidate.agents.length > 17
  )
    return null;
  if (
    candidate.agents.some(
      (agent) =>
        !agent ||
        typeof agent.id !== 'string' ||
        typeof agent.name !== 'string' ||
        !projects.has(agent.project) ||
        !states.has(agent.state) ||
        !agent.source ||
        !['available', 'unavailable'].includes(agent.source.health) ||
        !Array.isArray(agent.events),
    )
  )
    return null;
  return candidate as LiveSnapshot;
}

@Injectable({ providedIn: 'root' })
export class LiveTelemetryService {
  readonly snapshot = signal<LiveSnapshot | null>(null);
  readonly transport = signal<LiveTransport>('connecting');
  readonly now = signal(Date.now());
  readonly ageSeconds = computed(() => {
    const at = this.snapshot()?.observedAt;
    return at
      ? Math.max(0, Math.floor((this.now() - Date.parse(at)) / 1000))
      : null;
  });
  readonly fresh = computed(() => (this.ageSeconds() ?? Infinity) <= 10);
  readonly agents = computed(() => {
    const trusted =
      this.fresh() && ['streaming', 'polling'].includes(this.transport());
    return (this.snapshot()?.agents ?? []).map((agent) => ({
      ...agent,
      state: (trusted && agent.source.health === 'available'
        ? agent.state
        : 'unknown') as LiveAgentState,
      activity:
        trusted &&
        agent.source.health === 'available' &&
        agent.state === 'running'
          ? agent.activity
          : null,
      tool:
        trusted &&
        agent.source.health === 'available' &&
        agent.state === 'running'
          ? agent.tool
          : null,
    }));
  });

  private stream?: EventSource;
  private streamOpen = false;
  private pollTimer?: ReturnType<typeof setInterval>;
  private clockTimer?: ReturnType<typeof setInterval>;
  private pollPending = false;

  start(
    factory: (url: string) => EventSource = (url) => new EventSource(url),
  ): void {
    if (this.stream) return;
    this.transport.set('connecting');
    void this.refresh();
    try {
      this.stream = factory(`${baseUrl}/api/live/events`);
      this.stream.addEventListener('snapshot', (event) => {
        try {
          this.accept(JSON.parse((event as MessageEvent).data));
        } catch {
          this.transport.set('reconnecting');
        }
      });
      this.stream.onopen = () => {
        this.streamOpen = true;
        this.transport.set('streaming');
      };
      this.stream.onerror = () => {
        this.streamOpen = false;
        this.transport.set('reconnecting');
        void this.refresh();
      };
    } catch {
      this.transport.set('unavailable');
    }
    this.pollTimer = setInterval(() => void this.refresh(), 5_000);
    this.clockTimer = setInterval(() => this.now.set(Date.now()), 1_000);
  }

  stop(): void {
    this.stream?.close();
    this.stream = undefined;
    this.streamOpen = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.clockTimer) clearInterval(this.clockTimer);
    this.pollTimer = undefined;
    this.clockTimer = undefined;
    this.transport.set('unavailable');
  }

  async refresh(): Promise<void> {
    if (this.pollPending) return;
    this.pollPending = true;
    try {
      const response = await fetch(`${baseUrl}/api/live`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(4_000),
      });
      if (!response.ok) throw new Error('Live feed unavailable');
      const snapshot = parseSnapshot(await response.json());
      if (!snapshot) throw new Error('Invalid live feed');
      this.accept(snapshot);
      this.transport.set(this.streamOpen ? 'streaming' : 'polling');
    } catch {
      if (!this.streamOpen) this.transport.set('unavailable');
    } finally {
      this.pollPending = false;
    }
  }

  private accept(raw: unknown): void {
    const snapshot = parseSnapshot(raw);
    if (!snapshot) return;
    const current = this.snapshot();
    if (current) {
      const newerObservation =
        Date.parse(snapshot.observedAt) > Date.parse(current.observedAt);
      if (snapshot.sequence < current.sequence && !newerObservation) return;
      if (
        snapshot.sequence === current.sequence &&
        Date.parse(snapshot.observedAt) < Date.parse(current.observedAt)
      )
        return;
    }
    this.snapshot.set(snapshot);
    this.now.set(Date.now());
  }
}
