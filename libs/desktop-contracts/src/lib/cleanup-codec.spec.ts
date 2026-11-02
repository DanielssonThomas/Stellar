import { describe, expect, it } from 'vitest';
import { decodeCleanupReply } from './cleanup-codec';

describe('cleanup reply decoding', () => {
  it('accepts bounded nullable versioned replies', () => {
    expect(decodeCleanupReply({ version: 1, text: null })).toEqual({
      version: 1,
      text: null,
    });
    expect(decodeCleanupReply({ version: 1, text: 'clean' }).text).toBe(
      'clean',
    );
  });
  it.each([
    { version: 2, text: null },
    { version: 1 },
    { version: 1, text: 'a'.repeat(8193) },
    { version: 1, text: null, extra: true },
  ])('rejects incompatible frames', (frame) => {
    expect(() => decodeCleanupReply(frame)).toThrow();
  });
});
