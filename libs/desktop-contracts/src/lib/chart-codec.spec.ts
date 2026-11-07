import { describe, expect, it } from 'vitest';
import {
  decodeWorkspaceChart,
  decodeWorkspaceChartPayload,
} from './chart-codec';
import { decodeWorkspaceToolRequest } from './workspace-codec';
const chart = () => ({
  type: 'line',
  labels: ['Mon', 'Tue'],
  datasets: [{ label: 'Visits', values: [12, 18] }],
});
describe('bounded chart wire data', () => {
  it('validates chart content at the workspace IPC boundary', () => {
    const operation = {
      kind: 'open',
      instance_id: 'chart',
      surface: 'chart',
      prominence: 'primary',
      payload_json: JSON.stringify({ title: 'Visits', chart: chart() }),
    };
    const request = {
      version: 1,
      request_id: '1234567890abcdef1234567890abcdef',
      epoch: '2',
      turn_id: '00000000-0000-4000-8000-000000000001',
      expires_at_ms: '1700000015000',
      operation,
    };
    expect(decodeWorkspaceToolRequest(request).operation).toEqual(operation);
    expect(() =>
      decodeWorkspaceToolRequest({
        ...request,
        operation: {
          ...operation,
          payload_json: JSON.stringify({
            title: 'Visits',
            chart: { ...chart(), plugins: [] },
          }),
        },
      }),
    ).toThrow();
    const inline = {
      ...operation,
      surface: 'rich-text',
      payload_json: JSON.stringify({
        title: 'Report',
        blocks: [{ kind: 'chart', chart: { ...chart(), options: {} } }],
      }),
    };
    expect(() =>
      decodeWorkspaceToolRequest({ ...request, operation: inline }),
    ).toThrow();
  });
  it('accepts the supported charts and clones input arrays', () => {
    for (const type of ['line', 'bar', 'pie', 'doughnut']) {
      const value = { ...chart(), type };
      expect(decodeWorkspaceChart(value)).toEqual(value);
    }
    const value = chart(),
      decoded = decodeWorkspaceChart(value);
    decoded.datasets[0].values[0] = 1;
    expect(value.datasets[0].values[0]).toBe(12);
    expect(
      decodeWorkspaceChartPayload({ title: 'Visits', chart: chart() }),
    ).toEqual({ title: 'Visits', chart: chart() });
  });
  it('rejects executable options, malformed values and mismatched dimensions', () => {
    for (const value of [
      { ...chart(), options: {} },
      { ...chart(), plugins: [] },
      { ...chart(), type: 'radar' },
      { ...chart(), labels: [] },
      { ...chart(), labels: ['Mon'] },
      { ...chart(), x_label: null },
      { ...chart(), datasets: [{ label: 'Values', values: [Infinity, 1] }] },
      { ...chart(), datasets: [{ label: 'Values', values: [true, 1] }] },
      { ...chart(), datasets: [{ label: 'Values', values: [1e13, 1] }] },
      { ...chart(), labels: ['Mon', '\u0000'] },
      {
        ...chart(),
        type: 'pie',
        datasets: [{ label: 'Share', values: [-1, 2] }],
      },
      {
        ...chart(),
        type: 'pie',
        datasets: [{ label: 'Share', values: [0, 0] }],
      },
      {
        ...chart(),
        type: 'doughnut',
        datasets: [chart().datasets[0], chart().datasets[0]],
      },
    ])
      expect(() => decodeWorkspaceChart(value)).toThrow();
  });
  it('rejects accessors and sparse arrays without invoking an accessor', () => {
    const getter = { ...chart() };
    const value = chart();
    let read = false;
    Object.defineProperty(getter, 'labels', {
      enumerable: true,
      get() {
        read = true;
        return value.labels;
      },
    });
    expect(() => decodeWorkspaceChart(getter)).toThrow();
    expect(read).toBe(false);
    const labels = new Array(2);
    labels[1] = 'Tue';
    expect(() => decodeWorkspaceChart({ ...chart(), labels })).toThrow();
  });
});
