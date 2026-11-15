import { describe, expect, it } from 'vitest';
import { decodeIvyLifecycleLease } from './lifecycle-codec';

describe('native lifecycle lease boundary', () => {
  const lease = {
    operation: 'a'.repeat(32),
    kind: 'render',
    text: 'Canonical answer',
  };
  it('retains only a closed native operation, kind and bounded text', () => {
    expect(decodeIvyLifecycleLease(lease)).toEqual(lease);
    for (const patch of [
      { kind: 'process_complete' },
      { operation: 'model supplied' },
      { text: ' ' },
      { text: 'é'.repeat(131073) },
      { text: '\ud800' },
      { permission: true },
    ])
      expect(() => decodeIvyLifecycleLease({ ...lease, ...patch })).toThrow();
  });
});
