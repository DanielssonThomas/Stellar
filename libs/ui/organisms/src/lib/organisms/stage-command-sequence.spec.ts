import { describe, expect, it } from 'vitest';
import { createStageRegistry } from './stage-registry';

describe('shared presentation sequence', () => {
  it('allocates after every admitted caller ID, preserves replay and stops at exhaustion', () => {
    const registry = createStageRegistry({ test: () => ({ title: 'Safe' }) });
    const open = {
      contractVersion: 1,
      commandId: 10,
      instanceId: 'one',
      action: 'open',
      surface: 'test',
      prominence: 'primary',
      payload: {},
    };
    expect(registry.nextCommandId()).toBe(1);
    expect(registry.dispatch(open).status).toBe('applied');
    expect(registry.nextCommandId()).toBe(11);
    expect(registry.dispatch(open).status).toBe('duplicate');
    expect(registry.nextCommandId()).toBe(11);
    expect(registry.dispatch({ ...open, commandId: 20 }).status).toBe(
      'rejected',
    );
    expect(registry.nextCommandId()).toBe(21);
    registry.dispatch({
      contractVersion: 1,
      commandId: Number.MAX_SAFE_INTEGER,
      instanceId: 'one',
      action: 'focus',
    });
    expect(registry.nextCommandId()).toBeNull();
    registry.dispose();
    expect(registry.nextCommandId()).toBeNull();
  });
});
