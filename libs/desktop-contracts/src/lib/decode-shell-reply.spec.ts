import { describe, expect, it } from 'vitest';
import { decodeShellReply } from './decode-shell-reply';

describe('native readiness reply decoder', () => {
  it('accepts the current Rust serialization fixture', () => {
    const fixture: unknown = JSON.parse(
      '{"version":1,"application":"stellar-desktop","ready":true}',
    );
    expect(decodeShellReply(fixture)).toEqual(fixture);
  });

  it.each([
    null,
    [],
    'ready',
    {},
    { version: 2, application: 'stellar-desktop', ready: true },
    { version: 1, application: 'other', ready: true },
    { version: 1, application: 'stellar-desktop', ready: 'true' },
    { version: 1, application: 'stellar-desktop', ready: true, unknown: 1 },
  ])('rejects malformed and incompatible payloads: %j', (value) => {
    expect(() => decodeShellReply(value)).toThrow();
  });
});
