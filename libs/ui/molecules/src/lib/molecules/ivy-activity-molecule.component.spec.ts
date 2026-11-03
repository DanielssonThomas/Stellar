import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { IvyActivityMolecule } from './ivy-activity-molecule.component';

async function fixture() {
  const fixture = TestBed.createComponent(IvyActivityMolecule);
  fixture.componentRef.setInput('active', true);
  fixture.componentRef.setInput('turnId', 'turn');
  fixture.componentRef.setInput('actions', [
    {
      id: 'a',
      label: 'Update memory',
      status: 'running',
      running: true,
      confirmed: false,
      indicator: 'memory',
    },
  ]);
  await fixture.whenStable();
  return fixture;
}
describe('IvyActivityMolecule', () => {
  it('renders only actual sanitized actions and suppresses all chrome over presentations', async () => {
    const f = await fixture();
    expect(f.nativeElement.textContent).toContain('Updating memory');
    expect(f.nativeElement.querySelector('.memory-glyph')).not.toBeNull();
    expect(f.nativeElement.textContent).not.toContain('confirmed');
    f.componentRef.setInput('suppressed', true);
    await f.whenStable();
    expect(f.nativeElement.querySelector('[data-ivy-activity]')).toBeNull();
    f.destroy();
  });
  it('uses the shared skeleton while loading visible activity', async () => {
    const f = await fixture();
    f.componentRef.setInput('loading', true);
    await f.whenStable();
    expect(
      f.nativeElement.querySelector('stellar-skeleton-atom'),
    ).not.toBeNull();
    expect(f.nativeElement.getAttribute('aria-busy')).toBe('true');
    f.destroy();
  });
});
