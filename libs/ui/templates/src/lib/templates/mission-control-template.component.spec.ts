import { TestBed } from '@angular/core/testing';
import { DashboardStatusService } from '@stellar/service-dashboard-status';
import { describe, expect, it } from 'vitest';
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
          outstanding: [{ id: 'FACE-001', status: 'visually mismatched' }],
          validation: 'Phase 1 visual approval pending',
        },
      ],
    });
    service.loading.set(false);
    const fixture = TestBed.createComponent(MissionControlTemplate);
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
    fixture.destroy();
  });
});
