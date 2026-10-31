import { TestBed } from '@angular/core/testing';
import { http, HttpResponse } from 'msw';
import { DashboardStatusService } from '@stellar/service-dashboard-status';
import { describe, expect, it, vi } from 'vitest';
import { server } from '@stellar/test-support';
import { MissionControlTemplate } from './mission-control-template.component';

describe('MissionControlTemplate', () => {
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
