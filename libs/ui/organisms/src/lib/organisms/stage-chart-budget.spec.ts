import { describe, expect, it } from 'vitest';
import { createStageRegistry } from './stage-registry';
import { decodeStageCommand } from './stage-contract';
import {
  decodePresentationChart,
  decodePresentationText,
} from './presentation-decoders';
import { boundedJson } from './stage-json';

const decoders = {
  chart: decodePresentationChart,
  'rich-text': decodePresentationText,
};
const chart = () => ({
  type: 'line',
  labels: Array.from({ length: 64 }, (_, i) => 'L' + i),
  datasets: Array.from({ length: 8 }, (_, i) => ({
    label: 'Series' + i,
    values: Array(64).fill(0),
  })),
});
function open(surface: string, payload: unknown) {
  return {
    contractVersion: 1,
    commandId: 1,
    instanceId: 'chart',
    action: 'open',
    surface,
    payload,
    prominence: 'primary',
  };
}

describe('chart-aware Stage admission budget', () => {
  it('admits documented 64-label 8-dataset charts through raw command, payload and detached payload guards', () => {
    const payload = { title: 'Maximum chart', chart: chart() };
    const command = open('chart', payload);
    expect(boundedJson(command, 17408)).toBe(false);
    const decoded = decodeStageCommand(command, decoders);
    expect(decoded).not.toBeNull();
    const registry = createStageRegistry(decoders);
    expect(registry.dispatch(command).status).toBe('applied');
    expect(
      registry.dispatch({
        contractVersion: 1,
        commandId: 2,
        instanceId: 'chart',
        action: 'update',
        surface: 'chart',
        payload,
        expectedRevision: registry.snapshot()[0].revision,
      }).status,
    ).toBe('applied');
    expect(registry.snapshot()[0].payload).toEqual(payload);
    expect(Object.isFrozen(registry.snapshot()[0].payload)).toBe(true);
  });
  it('admits multiple maximum inline charts and the 32-block limit through the actual Stage registry', () => {
    const blocks = Array.from({ length: 32 }, () => ({
      kind: 'chart',
      chart: chart(),
    }));
    const payload = { title: 'Inline chart report', blocks };
    expect(
      new TextEncoder().encode(JSON.stringify(payload)).length,
    ).toBeLessThan(65536);
    const registry = createStageRegistry(decoders);
    expect(registry.dispatch(open('rich-text', payload)).status).toBe(
      'applied',
    );
    expect(registry.snapshot()[0].payload).toEqual(payload);
  });
  it('retains byte, schema and default nonchart-node limits even alongside a valid chart', () => {
    const table = {
      kind: 'table',
      columns: Array(8).fill('Column'),
      rows: Array.from({ length: 24 }, () => Array(8).fill('')),
    };
    for (const blocks of [
      [table, table],
      [{ kind: 'chart', chart: chart() }, table, table],
    ]) {
      expect(
        createStageRegistry(decoders).dispatch(
          open('rich-text', { title: 'Too many ordinary nodes', blocks }),
        ).status,
      ).toBe('rejected');
    }
    const oversized = chart();
    oversized.labels = Array(64).fill('x'.repeat(120));
    expect(
      createStageRegistry(decoders).dispatch(
        open('rich-text', {
          title: 'Over byte budget',
          blocks: Array.from({ length: 32 }, () => ({
            kind: 'chart',
            chart: oversized,
          })),
        }),
      ).status,
    ).toBe('rejected');
    for (const data of [
      { ...chart(), options: {} },
      { ...chart(), datasets: [{ label: 'Invalid', values: [1] }] },
    ])
      expect(
        createStageRegistry(decoders).dispatch(
          open('chart', { title: 'Invalid', chart: data }),
        ).status,
      ).toBe('rejected');
  });
  it('rejects accessors, iterator hooks, cycles and excessive depth without executing data hooks', () => {
    let calls = 0;
    const accessor = chart();
    Object.defineProperty(accessor, 'labels', {
      enumerable: true,
      get() {
        calls++;
        return ['A'];
      },
    });
    expect(
      decodeStageCommand(
        open('chart', { title: 'Accessor', chart: accessor }),
        decoders,
      ),
    ).toBeNull();
    const blocks = [{ kind: 'chart', chart: chart() }];
    Object.defineProperty(blocks, Symbol.iterator, {
      value: () => {
        calls++;
        throw Error('Must not run');
      },
    });
    expect(
      decodeStageCommand(
        open('rich-text', { title: 'Iterator', blocks }),
        decoders,
      ),
    ).toBeNull();
    const cyclic: Record<string, unknown> = {};
    cyclic['cycle'] = cyclic;
    const permissive = {
      test: (value: unknown) => value as Record<string, unknown>,
    };
    expect(decodeStageCommand(open('test', cyclic), permissive)).toBeNull();
    let deep: unknown = {};
    for (let i = 0; i < 9; i++) deep = { child: deep };
    expect(decodeStageCommand(open('test', deep), permissive)).toBeNull();
    expect(calls).toBe(0);
  });
});
