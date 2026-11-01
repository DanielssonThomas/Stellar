import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createInteractionController,
  type InteractionClock,
} from './interaction-controller';
import { initialState, type InteractionEffect } from './interaction-model';

function required<T>(value: T | null): T {
  if (value === null) throw new Error('Expected active resource');
  return value;
}

const clock: InteractionClock = {
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};

afterEach(() => vi.useRealTimers());

describe('clock-backed desktop interaction', () => {
  it('provides deterministic motion fallbacks and silence hysteresis under input jitter', () => {
    vi.useFakeTimers();
    const effects: InteractionEffect[] = [];
    const controller = createInteractionController({
      clock,
      onEffect: (effect) => effects.push(effect),
    });
    controller.dispatch({ type: 'manual-start' });
    vi.advanceTimersByTime(220);
    expect(controller.getState().phase).toBe('listening');
    controller.dispatch({ type: 'manual-end' });
    vi.advanceTimersByTime(899);
    expect(controller.getState().phase).toBe('hangover');
    controller.dispatch({ type: 'manual-start' });
    vi.advanceTimersByTime(1);
    expect(controller.getState().phase).toBe('listening');
    controller.dispatch({ type: 'manual-end' });
    vi.advanceTimersByTime(900);
    expect(controller.getState().phase).toBe('docking');
    vi.advanceTimersByTime(320);
    expect(controller.getState().phase).toBe('presenting');
    expect(effects.filter((e) => e.type === 'open-surface')).toHaveLength(1);
    controller.dispatch({ type: 'dismiss' });
    vi.advanceTimersByTime(260);
    expect(controller.getState().phase).toBe('idle');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels fallbacks when the renderer completes early', () => {
    vi.useFakeTimers();
    const controller = createInteractionController({ clock });
    const focusing = controller.dispatch({ type: 'manual-start' });
    expect(vi.getTimerCount()).toBe(1);
    controller.dispatch({
      type: 'motion-complete',
      generation: required(focusing.motion).generation,
    });
    expect(vi.getTimerCount()).toBe(0);
    expect(controller.getState().phase).toBe('listening');
  });

  it('disposes all effects and prevents pending callbacks from restoring a surface', () => {
    vi.useFakeTimers();
    const effects: InteractionEffect[] = [];
    const controller = createInteractionController({
      clock,
      onEffect: (effect) => effects.push(effect),
    });
    controller.dispatch({ type: 'capture-request' });
    controller.dispatch({ type: 'manual-start' });
    vi.advanceTimersByTime(220);
    controller.dispatch({ type: 'manual-end' });
    const generation = required(controller.getState().hangover);
    controller.dispose();
    controller.dispose();
    vi.runAllTimers();
    controller.dispatch({ type: 'hangover-timeout', generation });
    controller.dispatch({ type: 'manual-start' });
    expect(controller.getState().phase).toBe('shutdown');
    expect(controller.getState().surface).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(effects.filter((e) => e.type === 'stop-capture')).toHaveLength(1);
    expect(effects.filter((e) => e.type === 'open-surface')).toHaveLength(0);
  });

  it('queues synchronous host callbacks until the current transition is applied', () => {
    vi.useFakeTimers();
    const controller = createInteractionController({
      clock,
      onEffect(effect) {
        if (effect.type === 'start-capture')
          controller.dispatch({
            type: 'capture-result',
            requestId: effect.requestId,
            result: 'started',
          });
      },
    });
    controller.dispatch({ type: 'capture-request' });
    expect(controller.getState().microphone.status).toBe('capturing');
  });

  it('supports disposal requested synchronously from an effect consumer', () => {
    vi.useFakeTimers();
    const controller = createInteractionController({
      clock,
      onEffect(effect) {
        if (effect.type === 'animate') controller.dispose();
      },
    });
    controller.dispatch({ type: 'manual-start' });
    expect(controller.getState().phase).toBe('shutdown');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains configurable hangover with reduced motion and no animation timer', () => {
    vi.useFakeTimers();
    const controller = createInteractionController({
      clock,
      state: { ...initialState, reducedMotion: true, hangoverMs: 25 },
    });
    controller.dispatch({ type: 'manual-start' });
    expect(vi.getTimerCount()).toBe(0);
    controller.dispatch({ type: 'manual-end' });
    vi.advanceTimersByTime(24);
    expect(controller.getState().phase).toBe('hangover');
    vi.advanceTimersByTime(1);
    expect(controller.getState().phase).toBe('presenting');
    expect(vi.getTimerCount()).toBe(0);
  });
});
