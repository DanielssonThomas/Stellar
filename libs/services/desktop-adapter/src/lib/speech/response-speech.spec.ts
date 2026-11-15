import { describe, expect, it } from 'vitest';
import { responseSpeech } from './response-speech';
describe('committed prose speech chunks', () => {
  it('preserves sentences, abbreviations, times and Unicode within the byte limit', () => {
    const text =
      'Dr. Ivy has a meeting at 10.30. Then café ☕ and research. A final sentence.';
    const chunks = responseSpeech(text, 55);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join(' ')).toBe(text);
    expect(
      chunks.every((chunk) => new TextEncoder().encode(chunk).length <= 55),
    ).toBe(true);
  });
  it('splits a long completed sentence at words and refuses an oversized unbroken payload', () => {
    const text = 'word '.repeat(100).trim();
    expect(responseSpeech(text, 50).join(' ')).toBe(text);
    expect(responseSpeech('😀'.repeat(20), 50)).toEqual([]);
  });
});
