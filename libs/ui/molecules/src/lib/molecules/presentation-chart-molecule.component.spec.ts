import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { PresentationChartMolecule } from './presentation-chart-molecule.component';
describe('PresentationChartMolecule', () => {
  it('composes a titled standalone chart without executable options', async () => {
    await TestBed.configureTestingModule({
      imports: [PresentationChartMolecule],
    }).compileComponents();
    const fixture = TestBed.createComponent(PresentationChartMolecule);
    fixture.componentRef.setInput('payload', {
      title: 'Weekly visits',
      chart: {
        type: 'bar',
        labels: ['Mon'],
        datasets: [{ label: 'Visits', values: [12] }],
      },
    });
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('h2').textContent).toBe(
      'Weekly visits',
    );
    expect(
      fixture.nativeElement.querySelector('stellar-presentation-chart-atom'),
    ).not.toBeNull();
  });
  it('exposes loading without rendering an empty chart', async () => {
    await TestBed.configureTestingModule({
      imports: [PresentationChartMolecule],
    }).compileComponents();
    const fixture = TestBed.createComponent(PresentationChartMolecule);
    fixture.componentRef.setInput('loading', true);
    await fixture.whenStable();
    expect(
      fixture.nativeElement.querySelector('stellar-skeleton-atom'),
    ).not.toBeNull();
    expect(fixture.nativeElement.querySelector('canvas')).toBeNull();
  });
});
