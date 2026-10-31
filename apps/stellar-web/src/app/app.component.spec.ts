import { TestBed } from '@angular/core/testing';
import { DashboardStatusService } from '@stellar/service-dashboard-status';
import { server } from '@stellar/test-support';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { AppComponent } from './app.component';

describe('AppComponent', () => {
  it('composes Mission Control from the template library', async () => {
    await TestBed.configureTestingModule({
      imports: [AppComponent],
    }).compileComponents();
    server.use(
      http.get('http://127.0.0.1:4211/api/status', () =>
        HttpResponse.json({
          observedAt: '2026-10-31T19:00:00.000Z',
          agents: [],
          github: {
            state: 'unavailable',
            issues: [],
            pulls: [],
            source: 'GitHub',
          },
          characters: [],
        }),
      ),
    );
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    await vi.waitFor(() =>
      expect(
        TestBed.inject(DashboardStatusService).lastSuccessfulFetch(),
      ).not.toBeNull(),
    );
    expect(
      fixture.nativeElement.querySelector('stellar-mission-control-template'),
    ).not.toBeNull();
  });
});
