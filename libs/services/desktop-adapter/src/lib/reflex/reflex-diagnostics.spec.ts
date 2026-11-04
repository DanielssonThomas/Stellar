import { afterEach, beforeEach, expect, it } from 'vitest';
import { captureReflexDiagnostics } from './reflex-diagnostics';
const clearHistory = () => {
  performance.clearMeasures('stellar.reflex.latency');
  performance.clearMeasures('stellar.voice.latency');
};
beforeEach(clearHistory);
afterEach(clearHistory);
it('exports bounded timings and outcomes without conversation content or paths', () => {
  performance.measure('stellar.reflex.latency', {
    start: 0,
    end: 10,
    detail: {
      outcome: 'confirmed',
      text: 'private song',
      path: 'private path',
      stages_ms: { action_complete: 10, private_key: 123, inference_start: -1 },
    },
  });
  const report = captureReflexDiagnostics({
    enabled: true,
    status: 'Ready',
    last_route: 'Reflex · confirmed',
    mode: 'professional',
  });
  expect(report.reflex_summary.confirmed).toBe(1);
  expect(report.reflex[0].stages_ms).toEqual({ action_complete: 10 });
  expect(JSON.stringify(report)).not.toContain('private');
});
