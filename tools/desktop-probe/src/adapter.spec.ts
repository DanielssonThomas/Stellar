import { describe, expect, it } from 'vitest';
import { decodeError, decodeReply, describeError } from './adapter.js';

describe('generated contract runtime boundary', () => {
  const reply = {
    version: 1,
    sequence: '18446744073709551615',
    state: { kind: 'active', rms: 0.04 },
    sound_active: true,
  };
  it('preserves maximum integer string and omitted optional fields', () => {
    expect(decodeReply(reply)).toEqual(reply);
    expect(
      decodeReply({ ...reply, device_label: 'fixture' }).device_label,
    ).toBe('fixture');
    expect('device_label' in decodeReply(reply)).toBe(false);
  });
  it('rejects invalid versions, unknown variants, null outputs and lossy integers', () => {
    for (const changed of [
      { version: 2 },
      { sequence: Number('18446744073709551615') },
      { sequence: '18446744073709551616' },
      { device_label: null },
      { state: { kind: 'speech' } },
      { state: { kind: 'active', rms: Infinity } },
      { state: { kind: 'idle', extra: true } },
      { extra: true },
    ])
      expect(() => decodeReply({ ...reply, ...changed })).toThrow();
  });
  it('decodes typed errors and refuses unknown error payloads', () => {
    expect(
      describeError(decodeError({ code: 'unsupported_version', received: 2 })),
    ).toBe('Unsupported version 2');
    expect(() => decodeError({ code: 'invalid_level', extra: true })).toThrow();
    expect(() => decodeError('transport failure')).toThrow();
    expect(() => decodeError({ code: 'unknown' })).toThrow();
  });
});
