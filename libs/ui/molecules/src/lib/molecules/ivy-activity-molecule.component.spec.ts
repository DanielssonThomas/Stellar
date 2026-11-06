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
  it('holds the working anchor during terminal fade instead of jumping to the idle layout', async () => {
    const f = await fixture();
    const working = { x: 400, y: 200, width: 320, height: 320 };
    f.componentRef.setInput('emblem', working);
    await f.whenStable();
    f.componentRef.setInput('active', false);
    f.componentRef.setInput('emblem', {
      x: 320,
      y: 120,
      width: 480,
      height: 480,
    });
    await f.whenStable();
    expect(f.componentInstance.view().leaving).toBe(true);
    expect(f.componentInstance.anchor()).toEqual(working);
    f.destroy();
  });
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
