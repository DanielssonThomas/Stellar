import type {
  WorkspaceChart,
  WorkspaceChartPayload,
  WorkspaceChartType,
} from '../generated';
import { boundedString, DesktopContractError, record } from './wire-validation';

function object(value: unknown, required: string[], optional: string[] = []) {
  const result = record(value, required, optional);
  if (
    Object.getPrototypeOf(result) !== Object.prototype ||
    Reflect.ownKeys(result).some(
      (key) =>
        typeof key !== 'string' ||
        !Object.getOwnPropertyDescriptor(result, key)?.enumerable ||
        !('value' in (Object.getOwnPropertyDescriptor(result, key) ?? {})),
    )
  )
    throw new DesktopContractError('malformed');
  return result;
}

function label(value: unknown, maximum = 120): string {
  const result = boundedString(value, maximum);
  if (
    !result.trim() ||
    Array.from(result).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || (code >= 127 && code <= 159);
    })
  )
    throw new DesktopContractError('malformed');
  return result;
}

function list(value: unknown, maximum: number): unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < 1 ||
    value.length > maximum ||
    Reflect.ownKeys(value).length !== value.length + 1 ||
    Array.from({ length: value.length }, (_, i) =>
      Object.getOwnPropertyDescriptor(value, String(i)),
    ).some((item) => !item || !('value' in item) || !item.enumerable)
  )
    throw new DesktopContractError('malformed');
  return value;
}

export function decodeWorkspaceChart(value: unknown): WorkspaceChart {
  const data = object(
    value,
    ['type', 'labels', 'datasets'],
    ['x_label', 'y_label'],
  );
  const type = data['type'];
  if (
    typeof type !== 'string' ||
    !['line', 'bar', 'pie', 'doughnut'].includes(type)
  )
    throw new DesktopContractError('unknown-variant');
  const circular = type === 'pie' || type === 'doughnut';
  const labels = list(data['labels'], 64).map((value) => label(value));
  const datasets = list(data['datasets'], circular ? 1 : 8).map((value) => {
    const dataset = object(value, ['label', 'values']);
    const values = list(dataset['values'], 64).map((value) => {
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        Math.abs(value) > 1e12 ||
        (circular && value < 0)
      )
        throw new DesktopContractError('malformed');
      return value;
    });
    if (
      values.length !== labels.length ||
      (circular && !values.some((value) => value > 0))
    )
      throw new DesktopContractError('malformed');
    return { label: label(dataset['label']), values };
  });
  return {
    type: type as WorkspaceChartType,
    labels,
    datasets,
    ...(Object.hasOwn(data, 'x_label')
      ? { x_label: label(data['x_label']) }
      : {}),
    ...(Object.hasOwn(data, 'y_label')
      ? { y_label: label(data['y_label']) }
      : {}),
  };
}

export function decodeWorkspaceChartPayload(
  value: unknown,
): WorkspaceChartPayload {
  const data = object(value, ['title', 'chart']);
  return {
    title: label(data['title'], 240),
    chart: decodeWorkspaceChart(data['chart']),
  };
}

export function validateWorkspaceChartContent(
  surface: string,
  value: unknown,
): void {
  if (surface === 'chart') decodeWorkspaceChartPayload(value);
  if (
    surface === 'rich-text' &&
    value &&
    typeof value === 'object' &&
    'blocks' in value &&
    Array.isArray(value.blocks)
  ) {
    for (const block of value.blocks) {
      if (block && typeof block === 'object' && block.kind === 'chart') {
        const data = object(block, ['kind', 'chart']);
        decodeWorkspaceChart(data['chart']);
      }
    }
  }
}
