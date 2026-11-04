import { describe, expect, it } from 'vitest';
import corpus from '../../../fixtures/reflex-evaluation.json';
import type { ReflexPlan } from '@stellar/desktop-contracts';
import { ReflexController } from './reflex-controller';
import { reflexPercentiles } from './reflex-latency';
import { mediaActionDescriptions } from './media-actions';

describe('Reflex corpus fixture qualification (does not measure model accuracy)', () => {
  it('contains at least 150 distinct requests and exercises the complete registered dispatch path', async () => {
    expect(corpus.cases.length).toBeGreaterThanOrEqual(150);
    expect(
      new Set(corpus.cases.map((c) => c.text)).size,
    ).toBeGreaterThanOrEqual(150);
    expect(
      new Set(corpus.cases.map((c) => `${c.scenario}:${c.text}`)).size,
    ).toBe(corpus.cases.length);
    let executed = 0;
    performance.clearMeasures('stellar.reflex.latency');
    for (const row of corpus.cases) {
      const scenario =
        corpus.contexts[row.scenario as keyof typeof corpus.contexts];
      for (const action of scenario.actions) {
        if (action.id.startsWith('media.'))
          expect(action.description).toBe(
            mediaActionDescriptions[
              action.id.slice(6) as keyof typeof mediaActionDescriptions
            ],
          );
      }
      let calls = 0;
      const controller = new ReflexController({
        currentEpoch: () => 'fixture',
        environment: async () => ({
          epoch: 'fixture',
          context: JSON.stringify(scenario.context),
          actions: scenario.actions.map((a) => ({
            ...a,
            valid: () => true,
            execute: () => {
              calls++;
              return 'confirmed' as const;
            },
          })),
        }),
        infer: async () =>
          ({ ...row.expected, reply: 'Fixture acknowledgment.' }) as ReflexPlan,
      });
      const outcome = await controller.run(row.text, row.id, 'playful');
      expect(outcome.outcome, row.id).toBe(
        row.expected.route === 'action' ? 'confirmed' : row.expected.route,
      );
      expect(calls, row.id).toBe(row.expected.route === 'action' ? 1 : 0);
      executed += calls;
    }
    expect(executed).toBeGreaterThan(100);
    const timing = reflexPercentiles();
    expect(timing.count).toBeGreaterThan(0);
    expect(timing.all_ms.p95).not.toBeNull();
    console.info(
      'Reflex fixture-only pipeline timings',
      JSON.stringify(timing),
    );
  });
});
