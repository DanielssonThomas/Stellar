import { TestBed } from '@angular/core/testing';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '@stellar/test-support';
import { DashboardStatusService } from './dashboard-status.service';

describe('DashboardStatusService', () => {
  it('is injectable as a shared singleton', () => {
    TestBed.configureTestingModule({ providers: [DashboardStatusService] });

    const first = TestBed.inject(DashboardStatusService);
    const second = TestBed.inject(DashboardStatusService);

    expect(first).toBeInstanceOf(DashboardStatusService);
    expect(second).toBe(first);
  });

  it('preserves the last observation and marks it stale when refresh fails', async () => {
    const service = new DashboardStatusService();
    const snapshot = {
      observedAt: '2026-10-31T10:00:00Z',
      agents: [],
      github: {
        state: 'live' as const,
        issues: [],
        pulls: [],
        source: 'GitHub',
      },
    };
    let fail = false;
    server.use(
      http.get('http://127.0.0.1:4211/api/status', () => {
        return fail
          ? new HttpResponse(null, { status: 503 })
          : HttpResponse.json(snapshot);
      }),
    );
    await service.refresh();
    expect(service.snapshot()).toEqual(snapshot);
    fail = true;
    await service.refresh();
    expect(service.error()).toBe(true);
    expect(service.snapshot()).toEqual(snapshot);
  });
});
