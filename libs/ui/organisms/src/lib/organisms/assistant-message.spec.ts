import { describe, expect, it } from 'vitest';
import { decodeAssistantMessage } from './stage-contract';
import { createStageRegistry } from './stage-registry';

describe('trusted assistant message', () => {
  it('accepts bounded plain text, rejects malformed data and fences stale commands', () => {
    const registry = createStageRegistry({
      'assistant-message': decodeAssistantMessage,
    });
    const command = {
      contractVersion: 1,
      commandId: 2,
      instanceId: 'ivy-panel',
      action: 'open',
      surface: 'assistant-message',
      prominence: 'primary',
      payload: { title: 'Requested', body: '<script>literal</script>' },
    };
    expect(registry.dispatch(command).status).toBe('applied');
    expect(registry.dispatch({ ...command, commandId: 1 }).status).toBe(
      'rejected',
    );
    for (const payload of [
      { title: '', body: 'Hello' },
      { title: 'Hello', body: 'x'.repeat(8193) },
      { title: 'Hello', body: 'World', html: true },
    ])
      expect(
        registry.dispatch({ ...command, commandId: 3, payload }).status,
      ).toBe('rejected');
    expect(registry.snapshot()).toHaveLength(1);
    expect(
      registry.dispatch({
        ...command,
        commandId: 4,
        instanceId: 'large-panel',
        payload: { title: 'é'.repeat(80), body: '"'.repeat(8192) },
      }).status,
    ).toBe('applied');
  });
});
