import { describe, expect, it } from 'vitest';
import {
  initialState,
  type InteractionEvent,
  type InteractionState,
} from './interaction-model';
import { reduceInteraction } from './interaction-reducer';

function required<T>(value: T | null): T {
  if (value === null) throw new Error('Expected active resource');
  return value;
}

const step = (state: InteractionState, event: InteractionEvent) =>
  reduceInteraction(state, event).state;
const finishMotion = (state: InteractionState) =>
  step(state, {
    type: 'motion-complete',
    generation: required(state.motion).generation,
  });
const listen = () => finishMotion(step(initialState, { type: 'manual-start' }));
const dock = () => {
  const quiet = step(listen(), { type: 'manual-end' });
  return step(quiet, {
    type: 'hangover-timeout',
    generation: required(quiet.hangover),
  });
};
const capture = () => {
  const requested = step(initialState, { type: 'capture-request' });
  return step(requested, {
    type: 'capture-result',
    requestId: required(requested.microphone.requestId),
    result: 'started',
  });
};

describe('desktop interaction transitions', () => {
  it('completes manual focus, quiet hangover, docking and dismissal without microphone permission', () => {
    const focusing = step(initialState, { type: 'manual-start' });
    expect(focusing.phase).toBe('focusing');
    const listening = finishMotion(focusing);
    expect(listening.phase).toBe('listening');
    const quiet = reduceInteraction(listening, { type: 'manual-end' });
    expect(quiet.state.phase).toBe('hangover');
    expect(quiet.effects).toContainEqual({
      type: 'schedule-hangover',
      generation: quiet.state.hangover,
      delayMs: 900,
    });
    const docking = step(quiet.state, {
      type: 'hangover-timeout',
      generation: required(quiet.state.hangover),
    });
    expect(docking.phase).toBe('docking');
    const presenting = reduceInteraction(docking, {
      type: 'motion-complete',
      generation: required(docking.motion).generation,
    });
    expect(presenting.state.phase).toBe('presenting');
    expect(
      presenting.effects.filter((e) => e.type === 'open-surface'),
    ).toHaveLength(1);
    expect(presenting.state.microphone.status).toBe('stopped');
    const returning = step(presenting.state, { type: 'dismiss' });
    expect(returning.surface).toBeNull();
    expect(finishMotion(returning).phase).toBe('idle');
  });

  it('lets brief input finish focusing before starting hangover', () => {
    const focusing = step(initialState, { type: 'manual-start' });
    const ended = reduceInteraction(focusing, { type: 'manual-end' });
    expect(ended.state.motion).toEqual(focusing.motion);
    expect(ended.effects).toEqual([]);
    expect(finishMotion(ended.state).phase).toBe('hangover');
  });

  it('cancels docking on new activity and ignores its stale completion', () => {
    const docking = dock();
    const resumed = reduceInteraction(docking, { type: 'manual-start' });
    expect(resumed.effects).toContainEqual({
      type: 'cancel-animation',
      generation: required(docking.motion).generation,
    });
    expect(resumed.state.phase).toBe('focusing');
    expect(
      step(resumed.state, {
        type: 'motion-complete',
        generation: required(docking.motion).generation,
      }),
    ).toBe(resumed.state);
    expect(resumed.state.surface).toBeNull();
  });

  it('keeps one surface instance when activity repeats while it is open', () => {
    const presenting = finishMotion(dock());
    const active = finishMotion(step(presenting, { type: 'manual-start' }));
    const quiet = step(active, { type: 'manual-end' });
    const docking = step(quiet, {
      type: 'hangover-timeout',
      generation: required(quiet.hangover),
    });
    const result = reduceInteraction(docking, {
      type: 'motion-complete',
      generation: required(docking.motion).generation,
    });
    expect(result.state.surface).toEqual(presenting.surface);
    expect(result.effects.filter((e) => e.type === 'open-surface')).toEqual([]);
  });

  it('treats repeated activity and callback events as idempotent', () => {
    const focusing = step(initialState, { type: 'manual-start' });
    expect(reduceInteraction(focusing, { type: 'manual-start' })).toEqual({
      state: focusing,
      effects: [],
    });
    const listening = finishMotion(focusing);
    expect(
      step(listening, {
        type: 'motion-complete',
        generation: required(focusing.motion).generation,
      }),
    ).toBe(listening);
    const quiet = step(listening, { type: 'manual-end' });
    expect(step(quiet, { type: 'manual-end' })).toBe(quiet);
    const resumed = step(quiet, { type: 'manual-start' });
    expect(
      step(resumed, {
        type: 'hangover-timeout',
        generation: required(quiet.hangover),
      }),
    ).toBe(resumed);
  });

  it('tracks manual and microphone activity independently', () => {
    const capturing = capture();
    const requestId = required(capturing.microphone.requestId);
    const audio = finishMotion(
      step(capturing, { type: 'audio-activity', requestId, active: true }),
    );
    const both = step(audio, { type: 'manual-start' });
    const manualOnly = step(both, {
      type: 'audio-activity',
      requestId,
      active: false,
    });
    expect(manualOnly.phase).toBe('listening');
    expect(manualOnly.manualActive).toBe(true);
    expect(step(manualOnly, { type: 'manual-end' }).phase).toBe('hangover');
    const audioOnly = step(both, { type: 'manual-end' });
    expect(audioOnly.audioActive).toBe(true);
    expect(audioOnly.phase).toBe('listening');
  });

  it.each(['denied', 'missing'] as const)(
    'preserves manual activity after capture is %s',
    (result) => {
      const requested = step(listen(), { type: 'capture-request' });
      const failed = step(requested, {
        type: 'capture-result',
        requestId: required(requested.microphone.requestId),
        result,
      });
      expect(failed.microphone.status).toBe(result);
      expect(failed.phase).toBe('listening');
      expect(failed.manualActive).toBe(true);
    },
  );

  it.each([
    'microphone-disconnected',
    'microphone-muted',
    'microphone-stopped',
  ] as const)('cleans audio activity on %s', (type) => {
    const capturing = capture();
    const requestId = required(capturing.microphone.requestId);
    const active = step(capturing, {
      type: 'audio-activity',
      requestId,
      active: true,
    });
    const result = reduceInteraction(active, { type, requestId });
    expect(result.state.phase).toBe('idle');
    expect(result.state.motion).toBeNull();
    expect(result.state.audioActive).toBe(false);
    expect(result.effects).toContainEqual({ type: 'stop-capture', requestId });
    expect(
      step(result.state, { type: 'audio-activity', requestId, active: true }),
    ).toBe(result.state);
  });

  it.each(['hidden', 'minimized', 'shutdown'] as const)(
    'cancels resources and rejects stale resurrection after %s',
    (type) => {
      const capturing = capture();
      const requestId = required(capturing.microphone.requestId);
      const active = step(capturing, { type: 'manual-start' });
      const result = reduceInteraction(active, { type });
      expect(result.state.motion).toBeNull();
      expect(result.state.hangover).toBeNull();
      expect(result.effects).toContainEqual({
        type: 'stop-capture',
        requestId,
      });
      expect(
        step(result.state, {
          type: 'motion-complete',
          generation: required(active.motion).generation,
        }),
      ).toBe(result.state);
      expect(
        step(result.state, {
          type: 'capture-result',
          requestId,
          result: 'started',
        }),
      ).toBe(result.state);
      const resumed = step(result.state, { type: 'resume' });
      expect(resumed.phase).toBe(type === 'shutdown' ? 'shutdown' : 'idle');
      expect(resumed.microphone.requestId).toBeNull();
    },
  );

  it('rejects stale device results when a new capture request exists', () => {
    const old = capture();
    const idle = step(old, { type: 'dismiss' });
    const requested = step(idle, { type: 'capture-request' });
    expect(requested.microphone.requestId).not.toBe(old.microphone.requestId);
    expect(
      step(requested, {
        type: 'capture-result',
        requestId: required(old.microphone.requestId),
        result: 'denied',
      }),
    ).toBe(requested);
  });

  it('dismisses during focus and makes repeated dismissal harmless while returning', () => {
    const focused = step(initialState, { type: 'manual-start' });
    const returning = step(focused, { type: 'dismiss' });
    const repeat = reduceInteraction(returning, { type: 'dismiss' });
    expect(repeat.state.motion).toEqual(returning.motion);
    expect(repeat.effects).toEqual([]);
    expect(
      step(repeat.state, {
        type: 'motion-complete',
        generation: required(focused.motion).generation,
      }).phase,
    ).toBe('returning');
    expect(finishMotion(repeat.state).phase).toBe('idle');
  });

  it('reduced motion reaches stable states without animation callbacks', () => {
    const reduced = step(initialState, {
      type: 'reduced-motion',
      enabled: true,
    });
    const listening = step(reduced, { type: 'manual-start' });
    expect(listening.phase).toBe('listening');
    expect(listening.motion).toBeNull();
    const quiet = step(listening, { type: 'manual-end' });
    const presented = step(quiet, {
      type: 'hangover-timeout',
      generation: required(quiet.hangover),
    });
    expect(presented.phase).toBe('presenting');
    expect(presented.surface).not.toBeNull();
    expect(step(presented, { type: 'dismiss' }).phase).toBe('idle');
    const focusing = step(initialState, { type: 'manual-start' });
    const switched = reduceInteraction(focusing, {
      type: 'reduced-motion',
      enabled: true,
    });
    expect(switched.state.phase).toBe('listening');
    expect(switched.effects).toContainEqual({
      type: 'cancel-animation',
      generation: required(focusing.motion).generation,
    });
  });
});
