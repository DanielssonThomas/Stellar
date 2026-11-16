import { TestBed } from '@angular/core/testing';
import { PresentationChartAtom } from '@stellar/ui-atoms';
import { describe, expect, it } from 'vitest';
import { PresentationTextMolecule } from './presentation-text-molecule.component';
import {
  decodePresentationStatistics,
  statisticsChart,
  type PresentationStatistics,
} from './presentation-statistics';
const stats: PresentationStatistics = {
  title: 'Fixture statistics',
  source: 'Deterministic unit fixture, not telemetry',
  period: 'Fixture period A',
  state: 'ready',
  coverage: 'partial',
  freshness: 'stale',
  chartType: 'bar',
  metrics: [
    { name: 'Unknown', value: null, unit: 'tokens' },
    { name: 'Zero', value: 0, unit: 'tokens' },
    {
      name: 'Recorded',
      value: 5,
      unit: 'tokens',
      comparison: {
        value: 2,
        period: 'Fixture period B',
        source: 'Comparison fixture',
      },
    },
  ],
};
describe('statistical presentation', () => {
  it('requires explicit source, period, state, coverage, freshness and bounded metrics', () => {
    expect(decodePresentationStatistics(stats)).toEqual(stats);
    for (const bad of [
      { ...stats, source: '' },
      { ...stats, period: '' },
      { ...stats, freshness: 'fresh' },
      { ...stats, allowance: 10 },
      { ...stats, metrics: [{ name: 'A', value: NaN, unit: 'tokens' }] },
      {
        ...stats,
        metrics: [
          {
            name: 'A',
            value: null,
            unit: 'tokens',
            comparison: { value: 2, period: 'B', source: 'S' },
          },
        ],
      },
      { ...stats, state: 'loading' },
      { ...stats, metrics: Array(13).fill(stats.metrics[0]) },
    ])
      expect(decodePresentationStatistics(bad)).toBeNull();
    const accessor = Object.defineProperty({ ...stats }, 'source', {
      get: () => {
        throw Error('not called');
      },
      enumerable: true,
    });
    expect(decodePresentationStatistics(accessor)).toBeNull();
  });
  it('plots actual zero and omits unknown, with no conversion or invented comparisons', () => {
    for (const chartType of ['line', 'bar', 'doughnut'] as const)
      expect(statisticsChart({ ...stats, chartType })).toMatchObject({
        type: chartType,
        labels: ['Zero', 'Recorded'],
        datasets: [{ label: 'tokens', values: [0, 5] }],
      });
    expect(
      statisticsChart({ ...stats, metrics: [stats.metrics[0]] }),
    ).toBeNull();
    expect(
      statisticsChart({
        ...stats,
        chartType: 'doughnut',
        metrics: [stats.metrics[1]],
      }),
    ).toBeNull();
    expect(
      statisticsChart({
        ...stats,
        metrics: [
          ...stats.metrics,
          { name: 'Time', value: 1, unit: 'seconds' },
        ],
      }),
    ).toBeNull();
  });
  it('updates and unmounts the chart composition through loading/error/empty and removal', async () => {
    await TestBed.configureTestingModule({
      imports: [PresentationTextMolecule],
    })
      .overrideComponent(PresentationChartAtom, {
        set: {
          template:
            '<table><tr><td>{{ chart()?.labels?.join(", ") }}</td></tr></table>',
        },
      })
      .compileComponents();
    const fixture = TestBed.createComponent(PresentationTextMolecule);
    const set = async (statistics: PresentationStatistics) => {
      fixture.componentRef.setInput('payload', {
        title: 'Report',
        blocks: [
          { kind: 'paragraph', text: 'Preserved text' },
          { kind: 'statistics', statistics },
        ],
      });
      await fixture.whenStable();
    };
    await set(stats);
    const renderer = () =>
      fixture.debugElement.query(
        (node) => node.componentInstance instanceof PresentationChartAtom,
      )?.componentInstance as PresentationChartAtom | undefined;
    const first = renderer();
    expect(first?.chart()?.datasets[0].values).toEqual([0, 5]);
    const el: HTMLElement = fixture.nativeElement;
    expect(el.textContent).toContain('Unknown tokens');
    expect(el.textContent).toContain('0 tokens');
    expect(el.textContent).toContain('Partial coverage');
    expect(el.textContent).toContain('Stale data');
    expect(el.textContent).toContain('Comparison fixture');
    expect(el.querySelector('table')?.textContent).toContain('Recorded');
    fixture.detectChanges();
    await fixture.whenStable();
    expect(renderer()).toBe(first);
    await set({ ...stats, chartType: 'line' });
    expect(renderer()).toBe(first);
    expect(renderer()?.chart()?.type).toBe('line');
    await set({ ...stats, state: 'loading', metrics: [] });
    expect(el.querySelector('stellar-skeleton-atom')).not.toBeNull();
    expect(renderer()).toBeUndefined();
    expect(el.querySelector('table')).toBeNull();
    await set({ ...stats, state: 'error', metrics: [] });
    expect(el.textContent).toContain('Retrieval failed');
    expect(el.querySelector('dd')).toBeNull();
    await set({ ...stats, metrics: [] });
    expect(el.textContent).toContain('No observations');
    await set(stats);
    expect(renderer()).not.toBe(first);
    expect(renderer()?.chart()?.datasets[0].values).toEqual([0, 5]);
    fixture.destroy();
    expect(fixture.componentRef.hostView.destroyed).toBe(true);
  });
});
