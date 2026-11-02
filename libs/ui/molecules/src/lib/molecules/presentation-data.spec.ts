import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PRESENTATION_DATA } from './presentation-data';
import type { PresentationSourceView } from './presentation-model';
import { PresentationTelemetryMolecule } from './presentation-telemetry-molecule.component';

describe('source-backed presentation views', () => {
  afterEach(() => TestBed.resetTestingModule());
  it('masks stale activity without remounting unrelated source rows and releases its subscription', async () => {
    const source = signal<PresentationSourceView>({
      state: 'available',
      source: 'Native test source',
      observedAt: new Date().toISOString(),
      rows: [
        {
          id: 'one',
          label: 'Agent',
          value: 'Running',
          detail: 'Current activity',
          project: 'stellar',
        },
        {
          id: 'two',
          label: 'Other project',
          value: 'Completed',
          project: 'stellar-design',
        },
      ],
    });
    const release = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: PRESENTATION_DATA,
          useValue: {
            workflow: source,
            session: source,
            acquire: () => release,
          },
        },
      ],
    });
    const fixture = TestBed.createComponent(PresentationTelemetryMolecule);
    fixture.componentRef.setInput('payload', {
      title: 'Workflow',
      kind: 'workflow',
      project: 'stellar',
    });
    await fixture.whenStable();
    const row = fixture.nativeElement.querySelector('.source-row');
    expect(fixture.nativeElement.textContent).toContain('Running');
    expect(fixture.nativeElement.textContent).not.toContain('Other project');
    source.update((value) => ({
      ...value,
      observedAt: new Date(Date.now() - 60000).toISOString(),
    }));
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).not.toContain('Running');
    expect(fixture.nativeElement.textContent).not.toContain('Current activity');
    expect(fixture.nativeElement.textContent).toContain('Unavailable');
    expect(fixture.nativeElement.querySelector('.source-row')).toBe(row);
    fixture.destroy();
    expect(release).toHaveBeenCalledOnce();
  });
});
