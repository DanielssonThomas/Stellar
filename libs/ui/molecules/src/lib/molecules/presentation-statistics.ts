import {
  decodeWorkspaceChart,
  type WorkspaceChart,
} from '@stellar/desktop-contracts';

export interface StatisticalMetric {
  readonly name: string;
  readonly value: number | null;
  readonly unit: string;
  readonly comparison?: {
    readonly value: number;
    readonly period: string;
    readonly source: string;
  };
}
export interface PresentationStatistics {
  readonly title: string;
  readonly source: string;
  readonly period: string;
  readonly state: 'ready' | 'loading' | 'error';
  readonly coverage: 'complete' | 'partial';
  readonly freshness: 'current' | 'stale';
  readonly metrics: readonly StatisticalMetric[];
  readonly chartType?: 'line' | 'bar' | 'doughnut';
}

function record(
  value: unknown,
  required: string[],
  optional: string[] = [],
): value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return false;
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Reflect.ownKeys(value).every(
      (key) =>
        typeof key === 'string' &&
        (required.includes(key) || optional.includes(key)) &&
        Object.getOwnPropertyDescriptor(value, key)?.enumerable &&
        'value' in (Object.getOwnPropertyDescriptor(value, key) ?? {}),
    )
  );
}
const text = (value: unknown, limit = 240): value is string =>
  typeof value === 'string' &&
  !!value.trim() &&
  value.length <= limit &&
  !Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (
      code < 32 ||
      (code >= 127 && code <= 159) ||
      (code >= 0xd800 && code <= 0xdfff)
    );
  });
const number = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  Math.abs(value) <= 1e12;

export function decodePresentationStatistics(
  value: unknown,
): PresentationStatistics | null {
  if (
    !record(
      value,
      [
        'title',
        'source',
        'period',
        'state',
        'coverage',
        'freshness',
        'metrics',
      ],
      ['chartType'],
    ) ||
    !text(value['title']) ||
    !text(value['source'], 1024) ||
    !text(value['period']) ||
    !['ready', 'loading', 'error'].some((state) => value['state'] === state) ||
    !['complete', 'partial'].some(
      (coverage) => value['coverage'] === coverage,
    ) ||
    !['current', 'stale'].some(
      (freshness) => value['freshness'] === freshness,
    ) ||
    (Object.hasOwn(value, 'chartType') &&
      !['line', 'bar', 'doughnut'].some((type) => value['chartType'] === type))
  )
    return null;
  const metrics = value['metrics'];
  if (
    !Array.isArray(metrics) ||
    Object.getPrototypeOf(metrics) !== Array.prototype ||
    metrics.length > 12 ||
    Reflect.ownKeys(metrics).length !== metrics.length + 1
  )
    return null;
  const names = new Set<string>();
  for (let i = 0; i < metrics.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(metrics, String(i));
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
      return null;
    const metric: unknown = descriptor.value;
    if (
      !record(metric, ['name', 'value', 'unit'], ['comparison']) ||
      !text(metric['name'], 120) ||
      !text(metric['unit'], 60) ||
      (metric['value'] !== null && !number(metric['value'])) ||
      names.has(metric['name'])
    )
      return null;
    names.add(metric['name']);
    if (Object.hasOwn(metric, 'comparison')) {
      const comparison = metric['comparison'];
      if (
        metric['value'] === null ||
        !record(comparison, ['value', 'period', 'source']) ||
        !number(comparison['value']) ||
        !text(comparison['period']) ||
        !text(comparison['source'], 1024)
      )
        return null;
    }
  }
  if (value['state'] !== 'ready' && metrics.length) return null;
  return value as unknown as PresentationStatistics;
}

export function statisticsChart(
  stats: PresentationStatistics,
): WorkspaceChart | null {
  if (
    stats.state !== 'ready' ||
    !stats.chartType ||
    !stats.metrics.length ||
    stats.metrics.some((metric) => metric.unit !== stats.metrics[0].unit)
  )
    return null;
  const known = stats.metrics.filter(
    (metric): metric is StatisticalMetric & { value: number } =>
      metric.value !== null,
  );
  try {
    return decodeWorkspaceChart({
      type: stats.chartType,
      labels: known.map((metric) => metric.name),
      datasets: [
        {
          label: stats.metrics[0].unit,
          values: known.map((metric) => metric.value),
        },
      ],
    });
  } catch {
    return null;
  }
}
