import { TestBed } from '@angular/core/testing';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { server } from '../test-setup';
import { AppComponent } from './app.component';

describe('AppComponent', () => {
  it('shows observed profile data and distinguishes sessions from running agents', async () => {
    server.use(
      http.get('*/api/status', () =>
        HttpResponse.json({
          observedAt: '2026-10-30T21:00:00Z',
          agents: [
            {
              role: 'Architect',
              id: 'architect-cloud',
              mode: 'Cloud',
              model: 'gpt-6.1-sol',
              provider: 'openai-codex',
              sessionCount: 1,
              sessionState: 'recorded',
              lastActivity: '2026-10-30T20:00:00Z',
              usage: { inputTokens: 100, outputTokens: 20, apiCalls: 1 },
              events: [{ at: '2026-10-30T20:00:00Z', kind: 'session' }],
              source: 'Hermes local profile',
            },
          ],
          github: {
            state: 'live',
            issues: [
              {
                number: 160,
                title: 'Cloud profiles',
                url: 'https://github.com/DanielssonThomas/Stellar/issues/160',
                status: 'review',
                owner: 'owner:codex',
                blocked: false,
              },
            ],
            pulls: [],
            source: 'Public GitHub API',
          },
        }),
      ),
    );
    await TestBed.configureTestingModule({
      imports: [AppComponent],
    }).compileComponents();
    const fixture = TestBed.createComponent(AppComponent);
    await vi.waitFor(() =>
      expect(fixture.componentInstance.loading()).toBe(false),
    );
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('gpt-6.1-sol');
    expect(fixture.nativeElement.textContent).toContain('Session recorded');
    expect(fixture.nativeElement.textContent).toContain('not live agents');
    expect(
      fixture.nativeElement
        .querySelector('[data-testid="configured-profiles"]')
        .textContent.trim(),
    ).toBe('1');
    fixture.nativeElement.querySelectorAll('button')[1].click();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain(
      'No approved references',
    );
  });

  it('shows unavailable rather than zero when profile and session sources cannot be read', async () => {
    server.use(
      http.get('*/api/status', () =>
        HttpResponse.json({
          observedAt: '2026-10-30T21:00:00Z',
          agents: [
            {
              role: 'Architect',
              id: 'architect-cloud',
              mode: 'Cloud',
              model: 'Unavailable',
              provider: 'Unavailable',
              sessionCount: 0,
              sessionState: 'unavailable',
              lastActivity: null,
              usage: { inputTokens: 0, outputTokens: 0, apiCalls: 0 },
              events: [],
              source: 'Hermes profile unavailable',
            },
          ],
          github: {
            state: 'unavailable',
            issues: [],
            pulls: [],
            source: 'Public GitHub API',
          },
        }),
      ),
    );
    await TestBed.configureTestingModule({
      imports: [AppComponent],
    }).compileComponents();
    const fixture = TestBed.createComponent(AppComponent);
    await vi.waitFor(() =>
      expect(fixture.componentInstance.loading()).toBe(false),
    );
    fixture.detectChanges();
    expect(
      fixture.nativeElement
        .querySelector('[data-testid="configured-profiles"]')
        .textContent.trim(),
    ).toBe('0');
    expect(fixture.nativeElement.textContent).toContain(
      'Session history unavailable',
    );
    expect(fixture.nativeElement.textContent).toContain(
      'Session usage unavailable',
    );
    expect(fixture.nativeElement.textContent).toContain('Status unavailable');
  });

  it('labels aggregate usage as partial when one session source is unreadable', async () => {
    server.use(
      http.get('*/api/status', () =>
        HttpResponse.json({
          observedAt: '2026-10-30T21:00:00Z',
          agents: [
            {
              role: 'Architect',
              id: 'architect-cloud',
              mode: 'Cloud',
              model: 'gpt-6.1-sol',
              provider: 'openai-codex',
              sessionCount: 1,
              sessionState: 'recorded',
              lastActivity: null,
              usage: { inputTokens: 4, outputTokens: 2, apiCalls: 1 },
              events: [],
              source: 'Hermes local profile',
            },
            {
              role: 'Foreman',
              id: 'foreman-cloud',
              mode: 'Cloud',
              model: 'gpt-6.1-sol',
              provider: 'openai-codex',
              sessionCount: 0,
              sessionState: 'unavailable',
              lastActivity: null,
              usage: { inputTokens: 0, outputTokens: 0, apiCalls: 0 },
              events: [],
              source: 'Hermes local profile',
            },
          ],
          github: {
            state: 'unavailable',
            issues: [],
            pulls: [],
            source: 'Public GitHub API',
          },
        }),
      ),
    );
    await TestBed.configureTestingModule({
      imports: [AppComponent],
    }).compileComponents();
    const fixture = TestBed.createComponent(AppComponent);
    await vi.waitFor(() =>
      expect(fixture.componentInstance.loading()).toBe(false),
    );
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain(
      'Partial local session history',
    );
    expect(fixture.nativeElement.textContent).toContain(
      'Some profile session sources are unavailable',
    );
  });
});
