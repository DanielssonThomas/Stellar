import { describe, expect, it } from 'vitest';
import { chartColors, chartConfiguration } from './presentation-chart-config';
describe('trusted chart configuration', () => {
  it('copies chart values, uses semantic colors and disables motion', () => {
    const chart = {
      type: 'line' as const,
      labels: ['Mon'],
      datasets: [{ label: 'Visits', values: [12] }],
      y_label: 'Visits',
    };
    const configuration = chartConfiguration(chart, {
      foreground: '#fff',
      series: ['#abc', '#def'],
      line: '#333',
    });
    expect(configuration.options?.animation).toBe(false);
    expect(configuration.options?.responsive).toBe(true);
    expect(configuration.options?.maintainAspectRatio).toBe(false);
    expect(configuration.data.datasets[0].borderColor).toBe('#abc');
    configuration.data.datasets[0].data[0] = 99;
    expect(chart.datasets[0].values[0]).toBe(12);
  });
  it('uses category colors and omits cartesian axes for circular charts', () => {
    const configuration = chartConfiguration(
      {
        type: 'pie',
        labels: ['A', 'B'],
        datasets: [{ label: 'Share', values: [1, 2] }],
      },
      { foreground: '#fff', series: ['#abc', '#def'], line: '#333' },
    );
    expect(configuration.options?.scales).toBeUndefined();
    expect(configuration.data.datasets[0].backgroundColor).toEqual([
      '#abc',
      '#def',
    ]);
  });
  it('falls back to the current semantic primary when a series token is absent', () => {
    const element = document.createElement('div');
    element.style.setProperty('--stellar-color-primary', '#123456');
    element.style.setProperty('--stellar-color-foreground', '#abcdef');
    element.style.setProperty('--stellar-color-line', '#654321');
    element.style.setProperty('--stellar-color-chart-series-3', '#fedcba');
    expect(chartColors(element.style)).toEqual({
      foreground: '#abcdef',
      line: '#654321',
      series: [
        '#123456',
        '#123456',
        '#fedcba',
        '#123456',
        '#123456',
        '#123456',
        '#123456',
        '#123456',
      ],
    });
  });
});
