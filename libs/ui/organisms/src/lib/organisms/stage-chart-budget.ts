import { decodeWorkspaceChart } from '@stellar/desktop-contracts';
import { plainRecord } from './stage-json';

function chartNodes(value: unknown): number {
  try {
    const chart = decodeWorkspaceChart(value);
    const nodes =
      4 +
      chart.labels.length +
      chart.datasets.reduce(
        (total, dataset) => total + 3 + dataset.values.length,
        0,
      ) +
      Number(Object.hasOwn(chart, 'x_label')) +
      Number(Object.hasOwn(chart, 'y_label'));
    // The ordinary budget still pays for one placeholder at this exact chart position.
    return nodes - 1;
  } catch {
    return 0;
  }
}

export function chartJsonAllowance(surface: unknown, payload: unknown): number {
  if (!plainRecord(payload)) return 0;
  if (surface === 'chart') return chartNodes(payload['chart']);
  if (surface !== 'rich-text') return 0;
  const blocks = payload['blocks'];
  if (
    !Array.isArray(blocks) ||
    Object.getPrototypeOf(blocks) !== Array.prototype ||
    blocks.length > 32 ||
    Reflect.ownKeys(blocks).length !== blocks.length + 1
  )
    return 0;
  let extra = 0;
  for (let index = 0; index < blocks.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(blocks, String(index));
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
      return 0;
    const block: unknown = descriptor.value;
    if (!plainRecord(block)) return 0;
    if (block['kind'] === 'chart') extra += chartNodes(block['chart']);
  }
  return extra;
}
