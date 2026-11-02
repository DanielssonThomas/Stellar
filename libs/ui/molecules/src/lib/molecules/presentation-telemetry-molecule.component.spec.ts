import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { PresentationTelemetryMolecule } from './presentation-telemetry-molecule.component';

describe('PresentationTelemetryMolecule', () => {
  let fixture: ComponentFixture<PresentationTelemetryMolecule>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PresentationTelemetryMolecule],
    }).compileComponents();
    fixture = TestBed.createComponent(PresentationTelemetryMolecule);
    await fixture.whenStable();
  });

  it('reports absent source data instead of invented live activity', async () => {
    fixture.componentRef.setInput('payload', {
      kind: 'workflow',
      title: 'Workflow',
    });
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('No connected source');
    expect(fixture.nativeElement.textContent).toContain('Unavailable or stale');
    expect(fixture.nativeElement.textContent).not.toContain('Running');
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
