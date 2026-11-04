import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RequestStatusMolecule } from './request-status-molecule.component';

describe('RequestStatusMolecule', () => {
  let fixture: ComponentFixture<RequestStatusMolecule>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [RequestStatusMolecule],
    }).compileComponents();
    fixture = TestBed.createComponent(RequestStatusMolecule);
    await fixture.whenStable();
  });

  it('renders readiness without inventing a request', () => {
    expect(fixture.nativeElement.textContent).toContain('Awaiting a request');
    expect(fixture.nativeElement.querySelector('.constellation')).toBeNull();
  });

  it('shows observed stages, selected route and a bounded recent history', async () => {
    const entry = {
      id: 'one',
      sequence: 1,
      preview: 'Show my latest GitHub issue',
      source: 'typed',
      route: 'Terra',
      outcome: 'completed',
      started: 0,
      speaking: false,
      steps: [
        { key: 'route', label: 'Routed to Terra', elapsed: 2 },
        { key: 'result', label: 'Response complete', elapsed: 1234 },
      ],
    };
    fixture.componentRef.setInput('requests', [entry]);
    fixture.componentRef.setInput('reducedMotion', true);
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain(entry.preview);
    expect(fixture.nativeElement.textContent).toContain('Response complete');
    expect(fixture.nativeElement.textContent).toContain('1.2 s');
    expect(
      fixture.nativeElement.querySelector('.motion-reduced'),
    ).not.toBeNull();
    expect(
      fixture.nativeElement.querySelector('[data-current="true"]'),
    ).toBeNull();
    const close = vi.fn();
    fixture.componentInstance.dismiss.subscribe(close);
    fixture.nativeElement.querySelector('button').click();
    expect(close).toHaveBeenCalledOnce();
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
