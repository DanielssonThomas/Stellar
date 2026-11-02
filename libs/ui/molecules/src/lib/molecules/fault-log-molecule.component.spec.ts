import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { FaultLogMolecule } from './fault-log-molecule.component';

describe('FaultLogMolecule', () => {
  let fixture: ComponentFixture<FaultLogMolecule>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [FaultLogMolecule],
    }).compileComponents();
    fixture = TestBed.createComponent(FaultLogMolecule);
    await fixture.whenStable();
  });

  it('keeps unresolved faults visible and exposes an explicit recovery action', async () => {
    fixture.componentRef.setInput('entries', [
      {
        id: 1,
        time: '2026-11-03T01:00:00Z',
        category: 'Ivy',
        message: 'Response is uncertain.',
        status: 'active',
        count: 1,
      },
    ]);
    fixture.componentRef.setInput('active', true);
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain(
      'Response is uncertain.',
    );
    expect(fixture.nativeElement.textContent).toContain('Active');
    expect(fixture.nativeElement.textContent).not.toContain('Dismiss history');
    let requested = false;
    fixture.componentInstance.retry.subscribe(() => (requested = true));
    fixture.nativeElement.querySelector('button').click();
    expect(requested).toBe(true);
    fixture.componentRef.setInput('recovering', true);
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('button').disabled).toBe(true);
  });

  it('pages bounded history and permits dismissal after resolution', async () => {
    fixture.componentRef.setInput(
      'entries',
      [1, 2, 3].map((id) => ({
        id,
        time: '2026-11-03T01:00:00Z',
        category: 'Ivy',
        message: `Failure ${id}`,
        status: 'resolved',
        count: 1,
      })),
    );
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelectorAll('li')).toHaveLength(2);
    fixture.nativeElement.querySelector('[aria-label="Older errors"]').click();
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('Failure 3');
    expect(fixture.nativeElement.textContent).not.toContain('Failure 1');
    expect(fixture.nativeElement.textContent).toContain('Dismiss history');
  });

  it('shows a skeleton while loading', async () => {
    fixture.componentRef.setInput('loading', true);
    await fixture.whenStable();

    expect(
      fixture.nativeElement.querySelector('stellar-skeleton-atom'),
    ).not.toBeNull();
    expect(fixture.nativeElement.getAttribute('aria-busy')).toBe('true');
  });

  it('opens controls for a device fault instead of implying that Ivy retry fixes it', async () => {
    fixture.componentRef.setInput('entries', [
      {
        id: 1,
        time: '2026-11-03T01:00:00Z',
        category: 'Microphone',
        message: 'Choose another microphone.',
        status: 'active',
        count: 1,
      },
    ]);
    fixture.componentRef.setInput('active', true);
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('Open controls');
    expect(fixture.nativeElement.textContent).not.toContain('Try recovery');
  });
});
