import { initialState } from './interaction-model';
import type {
  InteractionEffect,
  InteractionEvent,
  InteractionState,
} from './interaction-model';
import { reduceInteraction } from './interaction-reducer';

export interface InteractionClock {
  schedule(callback: () => void, delayMs: number): () => void;
}

export interface InteractionControllerOptions {
  readonly clock: InteractionClock;
  readonly onEffect?: (effect: InteractionEffect) => void;
  readonly onChange?: (state: InteractionState) => void;
  readonly state?: InteractionState;
}

export function createInteractionController(
  options: InteractionControllerOptions,
) {
  let state = options.state ?? initialState;
  const timers = new Map<string, () => void>();
  const events: InteractionEvent[] = [];
  let processing = false;
  let disposed = false;
  let closing = false;

  const cancel = (key: string) => {
    timers.get(key)?.();
    timers.delete(key);
  };

  const schedule = (key: string, event: InteractionEvent, delayMs: number) => {
    cancel(key);
    timers.set(
      key,
      options.clock.schedule(() => {
        timers.delete(key);
        dispatch(event);
      }, delayMs),
    );
  };

  const apply = (effect: InteractionEffect) => {
    switch (effect.type) {
      case 'animate':
        schedule(
          `motion:${effect.generation}`,
          { type: 'motion-complete', generation: effect.generation },
          effect.durationMs,
        );
        break;
      case 'cancel-animation':
        cancel(`motion:${effect.generation}`);
        break;
      case 'schedule-hangover':
        schedule(
          `hangover:${effect.generation}`,
          { type: 'hangover-timeout', generation: effect.generation },
          effect.delayMs,
        );
        break;
      case 'cancel-hangover':
        cancel(`hangover:${effect.generation}`);
        break;
    }
    options.onEffect?.(effect);
  };

  function dispatch(event: InteractionEvent): InteractionState {
    if (disposed || (closing && event.type !== 'shutdown')) return state;
    events.push(event);
    if (processing) return state;
    processing = true;
    try {
      while (events.length) {
        const next = events.shift();
        if (!next) break;
        if (next.type === 'motion-complete')
          cancel(`motion:${next.generation}`);
        if (next.type === 'hangover-timeout')
          cancel(`hangover:${next.generation}`);
        const result = reduceInteraction(state, next);
        const changed = result.state !== state;
        state = result.state;
        if (state.phase === 'shutdown') {
          disposed = true;
          for (const cancelTimer of timers.values()) cancelTimer();
          timers.clear();
          events.length = 0;
        }
        for (const effect of result.effects) apply(effect);
        if (changed) options.onChange?.(state);
      }
    } finally {
      processing = false;
    }
    return state;
  }

  return {
    getState: () => state,
    dispatch,
    dispose() {
      if (disposed || closing) return;
      closing = true;
      dispatch({ type: 'shutdown' });
    },
  };
}
