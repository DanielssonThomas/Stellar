import { describe, expect, it } from 'vitest';
import { decodeMicrophoneReviewReply } from './microphone-permission-codec';
describe('microphone permission review contract', () => {
  it.each(['allowed', 'cancelled'])('accepts %s', (outcome) => {
    expect(decodeMicrophoneReviewReply({ version: 1, outcome })).toEqual({
      version: 1,
      outcome,
    });
  });
  it.each([
    null,
    [],
    {},
    { version: 2, outcome: 'allowed' },
    { version: 1, outcome: 'granted' },
    { version: 1, outcome: 'allowed', origin: 'remote' },
    { version: 1, outcome: ['allowed'] },
  ])('rejects malformed or incompatible %j', (value) => {
    expect(() => decodeMicrophoneReviewReply(value)).toThrow();
  });
});
