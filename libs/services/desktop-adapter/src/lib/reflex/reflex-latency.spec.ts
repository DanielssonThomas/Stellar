import { expect, it } from 'vitest';
import { reflexPercentiles } from './reflex-latency';

it('counts failures separately from successful clarification/delegation and includes their latency', () => {
  const entries = ['confirmed', 'clarify', 'hermes', 'uncertain'].map(
    (outcome, i) =>
      ({ duration: (i + 1) * 10, detail: { outcome } }) as PerformanceMeasure,
  );
  expect(reflexPercentiles(entries)).toEqual({
    count: 4,
    confirmed: 1,
    failures: 1,
    non_action_routes: 2,
    all_ms: { p50: 20, p95: 40 },
    confirmed_ms: { p50: 10, p95: 10 },
  });
});
