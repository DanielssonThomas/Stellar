import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { initialSpatialState } from '@stellar/desktop-interaction';
import { SpatialPresentationOrganism } from './spatial-presentation-organism.component';

describe(SpatialPresentationOrganism.name, () => {
  it('provides an accessible scene and a loading skeleton', async () => {
    await TestBed.configureTestingModule({
      imports: [SpatialPresentationOrganism],
    }).compileComponents();
    const fixture = TestBed.createComponent(SpatialPresentationOrganism);
    fixture.componentRef.setInput('scene', {
      title: 'Morning AI briefing',
      label: 'Fictional sample',
    });
    fixture.componentRef.setInput('state', initialSpatialState);
    fixture.componentRef.setInput('loading', true);
    fixture.detectChanges();

    const element: HTMLElement = fixture.nativeElement;
    expect(
      element.querySelector('[role="region"]')?.getAttribute('aria-labelledby'),
    ).toBe('spatial-title');
    expect(element.querySelector('h2')?.textContent?.trim()).toBe(
      'Morning AI briefing',
    );
    expect(element.querySelector('stellar-skeleton-atom')).not.toBeNull();
  });
});
