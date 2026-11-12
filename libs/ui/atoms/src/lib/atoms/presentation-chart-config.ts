import type { ChartConfiguration } from 'chart.js';
import type {
  WorkspaceChart,
  WorkspaceChartType,
} from '@stellar/desktop-contracts';

interface ChartColors {
  foreground: string;
  line: string;
  series: readonly string[];
}

export function chartColors(style: CSSStyleDeclaration): ChartColors {
  const token = (name: string) =>
    style.getPropertyValue(`--stellar-color-${name}`).trim();
  const foreground = token('foreground') || style.color;
  const primary = token('primary') || foreground;
  return {
    foreground,
    line: token('line') || foreground,
    series: Array.from(
      { length: 8 },
      (_, index) => token(`chart-series-${index + 1}`) || primary,
    ),
  };
}

export function chartConfiguration(
  chart: WorkspaceChart,
  colors: ChartColors,
): ChartConfiguration<WorkspaceChartType, number[], string> {
  const circular = chart.type === 'pie' || chart.type === 'doughnut';
  const palette = colors.series;
  return {
    type: chart.type,
    data: {
      labels: [...chart.labels],
      datasets: chart.datasets.map((dataset, index) => ({
        label: dataset.label,
        data: [...dataset.values],
        borderColor: circular ? colors.line : palette[index % palette.length],
        backgroundColor: circular
          ? chart.labels.map((_, i) => palette[i % palette.length])
          : palette[index % palette.length],
        borderWidth: 2,
        pointRadius: 3,
        pointHoverRadius: 5,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      color: colors.foreground,
      devicePixelRatio: Math.min(globalThis.devicePixelRatio || 1, 2),
      plugins: {
        legend: {
          display: chart.datasets.length > 1 || circular,
          position: 'bottom',
          labels: { color: colors.foreground, boxWidth: 12, padding: 16 },
        },
        tooltip: { enabled: true },
      },
      ...(circular
        ? {}
        : {
            scales: {
              x: {
                grid: { color: colors.line },
                ticks: { color: colors.foreground, maxRotation: 45 },
                title: {
                  display: !!chart.x_label,
                  text: chart.x_label,
                  color: colors.foreground,
                },
              },
              y: {
                grid: { color: colors.line },
                ticks: { color: colors.foreground },
                title: {
                  display: !!chart.y_label,
                  text: chart.y_label,
                  color: colors.foreground,
                },
              },
            },
          }),
    },
  };
}
