import { describe, expect, it } from 'vitest';
import { decodeMusicSnapshot } from './music-codec';

const valid = {
  version: 1,
  sequence: '18446744073709551615',
  status: 'capturing',
  levels: { level: 0.8, bass: 0.5, mid: 0.3, treble: 0.1 },
};
describe('music contract', () => {
  it('preserves the u64 sequence and bounded scalar features', () =>
    expect(decodeMusicSnapshot(valid)).toEqual(valid));
  it.each([NaN, Infinity, -0.1, 1.1, '0.1', null])(
    'rejects invalid feature %s',
    (level) => {
      expect(() =>
        decodeMusicSnapshot({ ...valid, levels: { ...valid.levels, level } }),
      ).toThrow();
    },
  );
  it.each([
    { ...valid, version: 2 },
    { ...valid, status: 'recording' },
    { ...valid, sequence: '01' },
    { ...valid, sequence: '18446744073709551616' },
    { ...valid, audio: [] },
    { ...valid, levels: { ...valid.levels, pcm: [] } },
  ])('rejects incompatible or enlarged payloads', (value) => {
    expect(() => decodeMusicSnapshot(value)).toThrow();
  });
});
