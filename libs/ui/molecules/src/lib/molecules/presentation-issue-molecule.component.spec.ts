import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceIssuePayload } from '@stellar/desktop-contracts';
import { PresentationIssueMolecule } from './presentation-issue-molecule.component';

describe('PresentationIssueMolecule', () => {
  let fixture: ComponentFixture<PresentationIssueMolecule>;
  const example = (): WorkspaceIssuePayload => ({
    title: 'Literal <script> issue',
    repository: 'example/repo',
    issue_number: 12,
    source: 'https://github.com/example/repo/issues/12',
    observed_at_ms: String(Date.now()),
    status: 'ready',
    issue: {
      state: 'closed',
      workflow_status: 'status:review',
      description: 'Concise description',
      labels: ['type:feature'],
      owner: 'worker:foreman-cloud',
      blockers: [],
      pull_requests: [
        { repository: 'example/repo', number: 13, title: 'Implementation' },
      ],
    },
  });

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PresentationIssueMolecule],
    }).compileComponents();
    fixture = TestBed.createComponent(PresentationIssueMolecule);
    await fixture.whenStable();
  });

  afterEach(() => {
    fixture.destroy();
    vi.useRealTimers();
  });

  it('renders literal metadata, state separately from workflow, source time and safe links', async () => {
    fixture.componentRef.setInput('payload', example());
    await fixture.whenStable();
    const host: HTMLElement = fixture.nativeElement;
    expect(host.textContent).toContain('Literal <script> issue');
    expect(host.querySelector('script')).toBeNull();
    expect(
      Array.from(host.querySelectorAll('dd')).map((el) => el.textContent),
    ).toEqual(['closed', 'status:review', 'worker:foreman-cloud']);
    expect(host.querySelector('time')?.getAttribute('datetime')).toBeTruthy();
    expect(host.querySelector('a')?.getAttribute('href')).toBe(
      'https://github.com/example/repo/pull/13',
    );
    expect(host.querySelector('a')?.getAttribute('rel')).toBe(
      'noopener noreferrer',
    );
    expect(host.getAttribute('data-render-state')).toBe('ready');
  });

  it('keeps missing and observed-empty lists distinct', async () => {
    const value = example();
    if (!value.issue) throw Error('Missing fixture');
    value.issue.labels = null;
    fixture.componentRef.setInput('payload', value);
    await fixture.whenStable();
    const host: HTMLElement = fixture.nativeElement;
    expect(
      host.querySelector('[aria-label="Issue labels"]')?.textContent,
    ).toContain('Not observed');
    expect(
      host.querySelector('[aria-label="Issue blockers"]')?.textContent,
    ).toContain('None observed');
  });

  it.each(['loading', 'unavailable', 'error'] as const)(
    'exposes %s without invented metadata',
    async (status) => {
      fixture.componentRef.setInput('payload', {
        ...example(),
        status,
        observed_at_ms: null,
        issue: null,
      });
      await fixture.whenStable();
      expect(fixture.nativeElement.getAttribute('data-render-state')).toBe(
        status,
      );
      expect(fixture.nativeElement.querySelector('dd')).toBeNull();
      expect(fixture.nativeElement.querySelector('time')).toBeNull();
    },
  );

  it('ages retained observations and cleans up the freshness timer', async () => {
    fixture.destroy();
    vi.useFakeTimers();
    fixture = TestBed.createComponent(PresentationIssueMolecule);
    fixture.componentRef.setInput('payload', example());
    fixture.detectChanges();
    expect(fixture.componentInstance.stale()).toBe(false);
    vi.advanceTimersByTime(1000);
    fixture.componentRef.setInput('payload', example());
    fixture.detectChanges();
    expect(fixture.componentInstance.stale()).toBe(false);
    fixture.componentRef.setInput('payload', {
      ...example(),
      observed_at_ms: String(Date.now() + 60000),
    });
    fixture.detectChanges();
    expect(fixture.componentInstance.stale()).toBe(true);
    fixture.componentRef.setInput('payload', example());
    fixture.detectChanges();
    vi.advanceTimersByTime(960000);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Stale observation');
    fixture.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fails closed for malformed direct component inputs', async () => {
    fixture.componentRef.setInput('payload', {
      ...example(),
      source: 'javascript:alert(1)',
    });
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('a')).toBeNull();
    expect(fixture.nativeElement.getAttribute('data-render-state')).toBe(
      'unavailable',
    );
  });

  it('shows a skeleton while loading', async () => {
    fixture.componentRef.setInput('loading', true);
    await fixture.whenStable();

    expect(
      fixture.nativeElement.querySelector('stellar-skeleton-atom'),
    ).not.toBeNull();
    expect(fixture.nativeElement.getAttribute('aria-busy')).toBe('true');
  });
});
