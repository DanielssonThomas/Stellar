import { TestBed } from '@angular/core/testing';
import { http, HttpResponse } from 'msw';
import { DashboardStatusService } from '@stellar/service-dashboard-status';
import { LiveTelemetryService } from '@stellar/service-dashboard-status';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '@stellar/test-support';
import { MissionControlTemplate } from './mission-control-template.component';

describe('MissionControlTemplate', () => {
  beforeEach(() => {
    server.use(
      http.get('http://127.0.0.1:4212/api/live', () =>
        HttpResponse.json({
          schemaVersion: 1,
          sequence: 1,
          observedAt: new Date().toISOString(),
          agents: [],
        }),
      ),
    );
  });

  it('keeps recorded sessions separate from verified execution and shows production blockers', async () => {
    await TestBed.configureTestingModule({
      imports: [MissionControlTemplate],
    }).compileComponents();
    const service = TestBed.inject(DashboardStatusService);
    service.snapshot.set({
      observedAt: new Date().toISOString(),
      agents: [
        {
          role: 'Designer',
          id: 'designer',
          mode: 'Independent',
          model: 'gpt-6.1-terra',
          provider: 'openai-codex',
          sessionCount: 2,
          sessionState: 'recorded',
          lastActivity: null,
          usage: { inputTokens: 0, outputTokens: 0, apiCalls: 0 },
          events: [],
          source: 'Hermes',
        },
      ],
      github: {
        state: 'live',
        issues: [
          {
            number: 161,
            title: 'Dashboard',
            url: 'https://github.com/example/161',
            status: 'in-progress',
            owner: 'owner:codex',
            blocked: false,
          },
        ],
        pulls: [],
        source: 'GitHub',
        complete: true,
      },
      characters: [
        {
          state: 'observed',
          id: 'stellar-assistant',
          source: 'Stellar-Design',
          assignedAgent: 'Designer',
          activity: 'unknown',
          workflow: 'phase1 refinement',
          contractApproved: true,
          referenceAvailable: true,
          vroid: {
            achieved: 3,
            total: 18,
            sourceRecorded: false,
            exportRecorded: false,
          },
          blender: { launchAllowed: false, sessionRecorded: false },
          blocker: 'Visual approval pending',
          nextAction: 'Resolve visual mismatch before handoff.',
          outstandingCount: 1,
          pipeline: {
            reference: 'done',
            bodyFace: 'current',
            vroidValidation: 'pending',
            blender: 'pending',
            finalReview: 'pending',
          },
          latestImage: 'latest',
          outstanding: [{ id: 'FACE-001', status: 'visually mismatched' }],
          validation: 'Phase 1 visual approval pending',
        },
      ],
    });
    let requests = 0;
    server.use(
      http.get('http://127.0.0.1:4211/api/status', () => {
        requests += 1;
        return HttpResponse.json(service.snapshot());
      }),
    );
    service.loading.set(false);
    const fixture = TestBed.createComponent(MissionControlTemplate);
    fixture.detectChanges();
    await vi.waitFor(() =>
      expect(service.lastSuccessfulFetch()).not.toBeNull(),
    );
    expect(requests).toBeGreaterThan(0);
    fixture.componentInstance.view.set('operations');
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain(
      'Running · no live source',
    );
    expect(fixture.nativeElement.textContent).toContain('execution unverified');
    expect(fixture.nativeElement.textContent).toContain('2 recorded sessions');
    fixture.componentInstance.view.set('studio');
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain(
      'Visual approval pending',
    );
    expect(fixture.nativeElement.textContent).toContain('FACE-001');
    expect(fixture.nativeElement.textContent).toContain(
      'View approved reference',
    );
    expect(
      fixture.nativeElement.querySelector(
        '[aria-label="Body / face: current"]',
      ),
    ).not.toBeNull();
    expect(fixture.nativeElement.textContent).toContain('1 open');
    service.snapshot.update((current) =>
      current
        ? {
            ...current,
            characters: current.characters?.map((character) => ({
              ...character,
              outstandingCount: 0,
              nextAction: 'Inspect recorded Blender outputs.',
              pipeline: {
                reference: 'done',
                bodyFace: 'done',
                vroidValidation: 'done',
                blender: 'current',
                finalReview: 'pending',
              } as const,
            })),
          }
        : current,
    );
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('[aria-label="Blender: current"]'),
    ).not.toBeNull();
    expect(fixture.nativeElement.textContent).toContain(
      'Inspect recorded Blender outputs.',
    );
    expect(fixture.nativeElement.textContent).toContain('0 open');
    const image = fixture.nativeElement.querySelector('img');
    const initialImageUrl = image.getAttribute('src');
    expect(initialImageUrl).toContain('revision=');
    service.snapshot.update((current) =>
      current
        ? { ...current, observedAt: '2026-10-31T18:00:00.000Z' }
        : current,
    );
    fixture.detectChanges();
    expect(image.getAttribute('src')).not.toBe(initialImageUrl);
    fixture.destroy();
  });

  it('opens Live by default and filters and selects real-feed agents', async () => {
    await TestBed.configureTestingModule({
      imports: [MissionControlTemplate],
    }).compileComponents();
    const live = TestBed.inject(LiveTelemetryService);
    const at = new Date().toISOString();
    live.snapshot.set({
      schemaVersion: 1,
      sequence: 2,
      observedAt: at,
      agents: [
        {
          id: 'peon',
          name: 'Peon',
          project: 'stellar',
          state: 'unknown',
          sessionId: null,
          task: null,
          activity: null,
          tool: null,
          model: null,
          provider: null,
          usage: null,
          startedAt: null,
          lastObservedAt: null,
          source: {
            kind: 'hermes-turn-lease',
            health: 'available',
            observedAt: at,
          },
          events: [],
        },
        {
          id: 'designer',
          name: 'Designer',
          project: 'stellar-design',
          state: 'running',
          sessionId: 'opaque',
          task: null,
          activity: 'Editing files',
          tool: 'Editing files',
          model: null,
          provider: null,
          usage: null,
          startedAt: at,
          lastObservedAt: at,
          source: {
            kind: 'hermes-turn-lease',
            health: 'available',
            observedAt: at,
          },
          events: [{ id: 'event-1', at, kind: 'tool', label: 'Editing files' }],
        },
      ],
    });
    live.transport.set('polling');
    server.use(
      http.get('http://127.0.0.1:4211/api/status', () =>
        HttpResponse.json({
          observedAt: at,
          agents: [],
          github: { state: 'live', issues: [], pulls: [], source: 'GitHub' },
        }),
      ),
    );
    const fixture = TestBed.createComponent(MissionControlTemplate);
    fixture.detectChanges();
    expect(fixture.componentInstance.view()).toBe('live');
    expect(fixture.nativeElement.querySelectorAll('.station')).toHaveLength(2);
    fixture.componentInstance.filterLive('stellar-design');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.station')).toHaveLength(1);
    fixture.nativeElement.querySelector('.station').click();
    fixture.detectChanges();
    expect(fixture.componentInstance.selectedLiveAgent()?.id).toBe('designer');
    expect(fixture.nativeElement.textContent).toContain('Editing files');
    fixture.componentInstance.selectLiveEvent('event-1', 'designer');
    const current = live.snapshot();
    if (!current) throw new Error('Live fixture missing');
    live.snapshot.set({
      ...current,
      sequence: 2,
      agents: current.agents.map((agent) => ({ ...agent, events: [] })),
    });
    fixture.detectChanges();
    expect(fixture.componentInstance.selectedLiveEvent()?.id).toBe('event-1');
    expect(fixture.nativeElement.textContent).toContain('Editing files');
    fixture.destroy();
  });

  it('labels a present reference neutrally when contract approval is unverified', async () => {
    await TestBed.configureTestingModule({
      imports: [MissionControlTemplate],
    }).compileComponents();
    const service = TestBed.inject(DashboardStatusService);
    service.snapshot.set({
      observedAt: '2026-10-31T18:00:00.000Z',
      agents: [],
      github: { state: 'live', issues: [], pulls: [], source: 'GitHub' },
      characters: [
        {
          state: 'observed',
          id: 'stellar-assistant',
          source: 'Stellar-Design',
          assignedAgent: 'Designer',
          activity: 'unknown',
          contractApproved: false,
          referenceAvailable: true,
          outstanding: [],
        },
      ],
    });
    server.use(
      http.get('http://127.0.0.1:4211/api/status', () =>
        HttpResponse.json(service.snapshot()),
      ),
    );
    service.loading.set(false);
    const fixture = TestBed.createComponent(MissionControlTemplate);
    fixture.componentInstance.view.set('studio');
    fixture.detectChanges();
    await vi.waitFor(() =>
      expect(service.lastSuccessfulFetch()).not.toBeNull(),
    );
    expect(fixture.nativeElement.textContent).toContain(
      'recorded; approval unverified',
    );
    expect(fixture.nativeElement.textContent).toContain(
      'View recorded reference',
    );
    expect(fixture.nativeElement.textContent).not.toContain(
      'View approved reference',
    );
    fixture.destroy();
  });

  it('shows the approval queue as unavailable when the GitHub feed is unavailable', async () => {
    await TestBed.configureTestingModule({
      imports: [MissionControlTemplate],
    }).compileComponents();
    const service = TestBed.inject(DashboardStatusService);
    service.snapshot.set({
      observedAt: '2026-10-31T18:00:00.000Z',
      agents: [],
      github: {
        state: 'unavailable',
        issues: [],
        pulls: [],
        source: 'GitHub',
      },
    });
    server.use(
      http.get('http://127.0.0.1:4211/api/status', () =>
        HttpResponse.json(service.snapshot()),
      ),
    );
    service.loading.set(false);
    const fixture = TestBed.createComponent(MissionControlTemplate);
    fixture.detectChanges();
    await vi.waitFor(() =>
      expect(service.lastSuccessfulFetch()).not.toBeNull(),
    );
    fixture.componentInstance.view.set('operations');
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain(
      'Approval queue unavailable',
    );
    expect(fixture.nativeElement.textContent).toContain(
      'GitHub approval and blocker data unavailable.',
    );
    expect(fixture.nativeElement.textContent).not.toContain(
      'No blocked issues or open PRs in the current feed.',
    );
    fixture.destroy();
  });
});
