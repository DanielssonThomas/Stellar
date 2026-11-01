import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { ActivitySummaryMolecule } from './activity-summary-molecule.component';

describe('ActivitySummaryMolecule', () => {
  let fixture: ComponentFixture<ActivitySummaryMolecule>;
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ActivitySummaryMolecule],
    }).compileComponents();
    fixture = TestBed.createComponent(ActivitySummaryMolecule);
  });

  it('shows duration, peak and optional input label as plain text', async () => {
    fixture.componentRef.setInput('payload', {
      durationMs: 62000,
      peakLevel: 0.72,
      inputLabel: '<script>alert(1)</script>',
    });
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('1m 02s');
    expect(fixture.nativeElement.textContent).toContain('72%');
    expect(fixture.nativeElement.textContent).toContain(
      '<script>alert(1)</script>',
    );
    expect(fixture.nativeElement.querySelector('script')).toBeNull();
  });

  it('uses shared skeleton and safe error/empty states', async () => {
    fixture.componentRef.setInput('loading', true);
    await fixture.whenStable();
    expect(
      fixture.nativeElement.querySelector('stellar-skeleton-atom'),
    ).not.toBeNull();
    expect(fixture.nativeElement.getAttribute('aria-busy')).toBe('true');
    fixture.componentRef.setInput('loading', false);
    fixture.componentRef.setInput('error', 'device failure');
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain(
      'Activity summary unavailable',
    );
    fixture.componentRef.setInput('error', null);
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('No activity recorded');
  });
});
