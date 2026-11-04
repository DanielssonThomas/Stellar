import { describe, expect, it } from 'vitest';
import { RequestTimeline, type RequestTrace } from './request-timeline';
describe('Request timeline observations', () => {
  it('settles cloud uncertainty from an authoritative receipt while preserving definitive and local outcomes', () => {
    let items: readonly RequestTrace[] = [];
    const trace = new RequestTimeline((next) => (items = next));
    trace.begin('cloud', 'Show my issue', 'typed');
    trace.route('cloud', 'Terra');
    trace.finish('cloud', 'uncertain', 'Result uncertain');
    trace.reconcile('cloud', 'completed', 'Response recovered');
    trace.reconcile('cloud', 'failed', 'Late failure');
    expect(items[0].outcome).toBe('completed');
    expect(items[0].steps.map((step) => step.label)).toContain(
      'Result uncertain',
    );
    expect(items[0].steps.at(-1)?.label).toBe('Response recovered');
    trace.begin('local', 'Skip', 'voice');
    trace.route('local', 'Reflex');
    trace.finish('local', 'uncertain', 'Result uncertain');
    trace.reconcile('local', 'completed', 'Unrelated cloud response');
    expect(items[1].outcome).toBe('uncertain');
  });
  it('joins routing and backend completion under one request and ignores late events', () => {
    let now = 0,
      items: readonly RequestTrace[] = [];
    const trace = new RequestTimeline(
      (next) => (items = next),
      () => now,
    );
    trace.begin('one', 'Please show my latest GitHub issue', 'typed');
    now = 10;
    trace.route('one', 'Terra');
    trace.begin('one', 'duplicate', 'voice');
    now = 20;
    trace.step('one', 'admitted', 'Request admitted');
    now = 30;
    trace.finish('one', 'completed', 'Response complete');
    trace.finish('one', 'failed', 'late failure');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      route: 'Terra',
      source: 'typed',
      outcome: 'completed',
    });
    expect(items[0].steps.at(-1)?.elapsed).toBe(30);
    trace.speech('one', 'synthesis');
    trace.speech('one', 'playing');
    trace.speech('one', 'completed');
    trace.speech('one', 'synthesis');
    expect(items[0].speaking).toBe(false);
    expect(items[0].steps.at(-1)?.label).toBe('Voice complete');
  });
  it('bounds history/content and clears private previews and stale IDs', () => {
    let items: readonly RequestTrace[] = [];
    const trace = new RequestTimeline((next) => (items = next));
    for (let i = 0; i < 20; i++)
      trace.begin(String(i), 'private '.repeat(40), 'voice');
    expect(items).toHaveLength(6);
    expect(items[0].preview.length).toBeLessThanOrEqual(120);
    trace.clear();
    trace.finish('19', 'completed', 'late completion');
    expect(items).toEqual([]);
  });
  it('does not turn cancellation or observer failures into execution changes', () => {
    const trace = new RequestTimeline(() => {
      throw Error('observer failed');
    });
    expect(() => {
      trace.begin('one', 'skip', 'voice');
      trace.finish('one', 'cancelled', 'Cancelled');
      trace.speech('one', 'playing');
    }).not.toThrow();
  });
  it('keeps failed-action narration observable and tolerates a broken clock', () => {
    let items: readonly RequestTrace[] = [];
    const trace = new RequestTimeline(
      (next) => (items = next),
      () => {
        throw Error('clock failed');
      },
    );
    trace.begin('one', 'close pane', 'voice');
    trace.finish('one', 'rejected', 'Workspace changed');
    trace.speech('one', 'synthesis');
    trace.speech('one', 'failed');
    expect(items[0].speaking).toBe(false);
    expect(items[0].steps.at(-1)).toMatchObject({
      label: 'Voice unavailable',
      elapsed: 0,
    });
  });
});
