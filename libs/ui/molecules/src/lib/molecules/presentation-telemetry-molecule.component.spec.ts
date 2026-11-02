import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { signal } from '@angular/core';
import { PRESENTATION_DATA } from './presentation-data';
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

  it('keeps global source limitations alongside project-filtered agents', async () => {
    fixture.destroy();
    TestBed.resetTestingModule();
    const source = signal({
      source: 'Verified source',
      observedAt: new Date().toISOString(),
      state: 'available' as const,
      rows: [
        {
          id: 'stellar',
          label: 'Stellar agent',
          value: 'Running',
          project: 'stellar',
        },
        {
          id: 'design',
          label: 'Design agent',
          value: 'Running',
          project: 'stellar-design',
        },
        {
          id: 'limits',
          label: 'Task bindings',
          value: 'Unavailable from this source',
        },
      ],
    });
    TestBed.configureTestingModule({
      imports: [PresentationTelemetryMolecule],
      providers: [
        {
          provide: PRESENTATION_DATA,
          useValue: {
            workflow: source,
            session: source,
            acquire: () => () => undefined,
          },
        },
      ],
    });
    fixture = TestBed.createComponent(PresentationTelemetryMolecule);
    fixture.componentRef.setInput('payload', {
      kind: 'workflow',
      title: 'Workflow',
      project: 'stellar',
    });
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('Stellar agent');
    expect(fixture.nativeElement.textContent).toContain('Task bindings');
    expect(fixture.nativeElement.textContent).not.toContain('Design agent');
  });
});
