export type ReflexTimingStage =
  | 'inference_start'
  | 'inference_complete'
  | 'action_dispatch'
  | 'action_complete';

/** Bounded local diagnostics. Never includes text, action targets or session identifiers. */
export class ReflexLatency {
  private readonly start = performance.now();
  private readonly stages: Partial<Record<ReflexTimingStage, number>> = {};
  point(stage: ReflexTimingStage) {
    this.stages[stage] ??= performance.now() - this.start;
  }
  finish(outcome: string) {
    const entries = performance.getEntriesByName('stellar.reflex.latency');
    if (entries.length >= 128)
      performance.clearMeasures('stellar.reflex.latency');
    performance.measure('stellar.reflex.latency', {
      start: this.start,
      end: performance.now(),
      detail: { outcome, stages_ms: this.stages },
    });
  }
}

export function reflexPercentiles(
  entries = performance.getEntriesByName('stellar.reflex.latency'),
) {
  const percentile = (values: number[], p: number) =>
    values.length
      ? values.sort((a, b) => a - b)[Math.ceil(values.length * p) - 1]
      : null;
  const values = entries.map((e) => e.duration);
  const completed = entries.filter(
    (e) => (e as PerformanceMeasure).detail?.outcome === 'confirmed',
  );
  const failures = entries.filter((e) =>
    ['rejected', 'uncertain', 'cancelled', 'unavailable'].includes(
      (e as PerformanceMeasure).detail?.outcome,
    ),
  ).length;
  return {
    count: values.length,
    confirmed: completed.length,
    failures,
    non_action_routes: values.length - completed.length - failures,
    all_ms: { p50: percentile(values, 0.5), p95: percentile(values, 0.95) },
    confirmed_ms: {
      p50: percentile(
        completed.map((e) => e.duration),
        0.5,
      ),
      p95: percentile(
        completed.map((e) => e.duration),
        0.95,
      ),
    },
  };
}
