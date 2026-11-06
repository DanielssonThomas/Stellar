import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PresentationChartAtom } from './presentation-chart-atom.component';
const mocks = vi.hoisted(() => ({
  created: [] as unknown[],
  destroy: vi.fn(),
  fail: false,
}));
vi.mock('chart.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('chart.js')>();
  return {
    ...actual,
    Chart: class {
      ctx = mocks.fail ? null : {};
      static register = vi.fn();
      constructor(_canvas: HTMLCanvasElement, configuration: unknown) {
        mocks.created.push(configuration);
      }
      destroy() {
        mocks.destroy();
      }
    },
  };
});
const chart = {
  type: 'line',
  labels: ['Mon', 'Tue'],
  datasets: [{ label: 'Visits', values: [12, 18] }],
};
describe('PresentationChartAtom', () => {
  let fixture: ComponentFixture<PresentationChartAtom>;
  beforeEach(async () => {
    mocks.created.length = 0;
    mocks.fail = false;
    mocks.destroy.mockClear();
    await TestBed.configureTestingModule({
      imports: [PresentationChartAtom],
    }).compileComponents();
    fixture = TestBed.createComponent(PresentationChartAtom);
    fixture.componentRef.setInput('chart', chart);
    fixture.componentRef.setInput('title', 'Weekly visits');
    await fixture.whenStable();
  });
  it('draws bounded data and exposes an accessible data table', () => {
    expect(mocks.created).toHaveLength(1);
    expect(
      fixture.nativeElement.querySelector('canvas').getAttribute('aria-label'),
    ).toContain('Weekly visits');
    expect(fixture.nativeElement.querySelector('table').textContent).toContain(
      'Visits',
    );
    expect(fixture.nativeElement.querySelector('table').textContent).toContain(
      '18',
    );
    expect(fixture.nativeElement.getAttribute('data-render-state')).toBe(
      'ready',
    );
  });
  it('releases the previous chart on update and on removal', async () => {
    fixture.componentRef.setInput('chart', { ...chart, type: 'bar' });
    await fixture.whenStable();
    expect(mocks.created).toHaveLength(2);
    expect(mocks.destroy).toHaveBeenCalledTimes(1);
    fixture.destroy();
    expect(mocks.destroy).toHaveBeenCalledTimes(2);
  });
  it('rejects arbitrary chart options before calling the drawing library', async () => {
    fixture.componentRef.setInput('chart', {
      ...chart,
      options: { onClick: 'execute' },
    });
    await fixture.whenStable();
    expect(mocks.created).toHaveLength(1);
    expect(fixture.nativeElement.getAttribute('data-render-state')).toBe(
      'error',
    );
  });
  it('releases the canvas and uses the existing loading primitive', async () => {
    fixture.componentRef.setInput('loading', true);
    await fixture.whenStable();
    expect(
      fixture.nativeElement.querySelector('stellar-skeleton-atom'),
    ).not.toBeNull();
    expect(fixture.nativeElement.querySelector('canvas')).toBeNull();
    expect(mocks.destroy).toHaveBeenCalledTimes(1);
  });
  it('reports a failed drawing context while retaining accessible data', async () => {
    mocks.fail = true;
    fixture.componentRef.setInput('chart', { ...chart, type: 'bar' });
    await fixture.whenStable();
    expect(fixture.nativeElement.getAttribute('data-render-state')).toBe(
      'error',
    );
    expect(fixture.nativeElement.querySelector('table').textContent).toContain(
      '18',
    );
    expect(mocks.destroy).toHaveBeenCalledTimes(2);
  });
});
