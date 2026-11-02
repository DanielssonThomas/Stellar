import { describe, expect, it } from 'vitest';
import { decodeTelemetrySnapshot } from './telemetry-codec';

const valid = () => ({
  schemaVersion: 1,
  sequence: 1,
  observedAt: '2026-11-02T12:00:00Z',
  agents: [
    {
      id: 'architect',
      name: 'Architect',
      project: 'stellar',
      state: 'running',
      sessionId: 'abcdef0123456789',
      task: null,
      activity: 'Processing a turn',
      tool: null,
      model: null,
      provider: null,
      usage: { inputTokens: 1, outputTokens: 2 },
      startedAt: null,
      lastObservedAt: null,
      source: {
        kind: 'hermes-turn-lease',
        health: 'available',
        observedAt: '2026-11-02T12:00:00Z',
      },
      events: [],
    },
  ],
});
describe('telemetry boundary', () => {
  it('accepts source-backed fields and rejects unknown nested fields and private task values', () => {
    expect(decodeTelemetrySnapshot(valid()).agents[0].task).toBeNull();
    const input = valid();
    Object.assign(input.agents[0].source, { secret: 'private' });
    expect(() => decodeTelemetrySnapshot(input)).toThrow();
    const task = valid();
    Object.assign(task.agents[0], { task: 'private' });
    expect(() => decodeTelemetrySnapshot(task)).toThrow();
    const usage = valid();
    Object.assign(usage.agents[0].usage, { inputTokens: -1 });
    expect(() => decodeTelemetrySnapshot(usage)).toThrow();
  });
});
