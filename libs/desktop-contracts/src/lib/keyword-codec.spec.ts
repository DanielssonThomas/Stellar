import { describe, expect, it } from 'vitest';
import { decodeKeywordReply, decodeKeywordRequest } from './keyword-codec';
describe('keyword wire contracts', () => {
  const request = {
    version: 1,
    epoch: '0',
    stream_id: 'bounded-stream',
    sequence: 12,
    pcm: [-32768, 32767],
    threshold: 0.008,
    mode: 'passive',
  };
  it('preserves bounded PCM, mode and exact command identity', () => {
    expect(decodeKeywordRequest(request)).toEqual(request);
    expect(
      decodeKeywordReply({
        sequence: 12,
        detection: { command: 'prompt cancel', end_sample: 16000 },
      }),
    ).toEqual({
      sequence: 12,
      detection: { command: 'prompt cancel', end_sample: 16000 },
    });
    expect(
      decodeKeywordReply({ sequence: 12, detection: null }).detection,
    ).toBeNull();
  });
  it('rejects invalid bounds, unrecognized modes, and extra fields', () => {
    for (const change of [
      { pcm: [] },
      { pcm: Array(641).fill(0) },
      { pcm: [32768] },
      { threshold: NaN },
      { threshold: 0 },
      { sequence: -1 },
      { sequence: 2 ** 32 },
      { stream_id: '../model' },
      { mode: 'auto' },
      { version: 2 },
      { extra: true },
    ])
      expect(() => decodeKeywordRequest({ ...request, ...change })).toThrow();
    for (const change of [
      { detection: undefined },
      { detection: { command: 'I.V.', end_sample: 0 } },
      { detection: { command: 'clear', end_sample: -1 } },
      { extra: true },
    ])
      expect(() =>
        decodeKeywordReply({ sequence: 12, detection: null, ...change }),
      ).toThrow();
  });
});
