import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DashboardStatusService } from './dashboard-status.service';

describe('DashboardStatusService', () => {
  afterEach(() => vi.unstubAllGlobals());
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
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: async () => snapshot })
        .mockRejectedValueOnce(new Error('offline')),
    );
    await service.refresh();
    expect(service.snapshot()).toEqual(snapshot);
    await service.refresh();
    expect(service.error()).toBe(true);
    expect(service.snapshot()).toEqual(snapshot);
  });
});
