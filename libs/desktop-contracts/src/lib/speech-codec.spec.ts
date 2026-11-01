import { describe, expect, it } from 'vitest';
import {
  decodeSpeechError,
  decodeSpeechRequest,
  decodeSpeechStopRequest,
  decodeSpeechSnapshot,
  decodeSpeechSpeakRequest,
  decodeSpeechTranscribeRequest,
  decodeSpeechTranscript,
} from './speech-codec';

const utterance_id = '11111111-2222-4333-8444-555555555555';
const input = {
  version: 1,
  epoch: '0',
  utterance_id,
  sample_rate_hz: 16000,
  pcm: [-32768, 0, 32767],
};

describe('speech wire boundary', () => {
  it('preserves exact signed PCM and copies the bounded caller buffer', () => {
    const decoded = decodeSpeechTranscribeRequest(input);
    expect(decoded).toEqual(input);
    expect(decoded.pcm).not.toBe(input.pcm);
    expect(
      decodeSpeechTranscribeRequest({
        ...input,
        pcm: Array(320000).fill(-32768),
      }).pcm,
    ).toHaveLength(320000);
  });

  it.each([
    { pcm: [] },
    { pcm: Array(320001).fill(0) },
    { pcm: [32768] },
    { pcm: [-32769] },
    { pcm: [0.5] },
    { pcm: [NaN] },
    { pcm: ['0'] },
    { pcm: new Int16Array(2) },
    { pcm: Array(2) },
    { sample_rate_hz: 48000 },
    { utterance_id: 'arbitrary-path' },
    { utterance_id: utterance_id.toUpperCase().replace('1111', 'ABCD') },
    { version: 2 },
    { epoch: '01' },
    { epoch: '18446744073709551616' },
    { path: 'not-allowed' },
  ])('rejects malformed audio input %j', (change) => {
    expect(() =>
      decodeSpeechTranscribeRequest({ ...input, ...change }),
    ).toThrow();
  });

  it('accepts empty recognition without inventing a user turn', () => {
    expect(
      decodeSpeechTranscript({ version: 1, utterance_id, text: '' }).text,
    ).toBe('');
    expect(() =>
      decodeSpeechTranscript({
        version: 1,
        utterance_id,
        text: 'é'.repeat(4097),
      }),
    ).toThrow();
  });

  it('bounds local synthesis by UTF-8 bytes and refuses empty or malformed Unicode', () => {
    expect(
      decodeSpeechSpeakRequest({
        version: 1,
        epoch: '0',
        utterance_id,
        text: 'é'.repeat(2000),
      }).text,
    ).toHaveLength(2000);
    for (const text of ['', '  ', 'é'.repeat(2001), '\ud800'])
      expect(() =>
        decodeSpeechSpeakRequest({
          version: 1,
          epoch: '0',
          utterance_id,
          text,
        }),
      ).toThrow();
  });

  it('validates revision and enum changes intentionally', () => {
    const state = {
      version: 1,
      revision: '18446744073709551615',
      epoch: '0',
      operation_id: utterance_id,
      state: 'speaking',
      error: null,
    };
    expect(decodeSpeechSnapshot(state)).toEqual(state);
    for (const change of [
      { revision: '18446744073709551616' },
      { revision: '01' },
      { state: 'cloud' },
      { error: 'raw private error' },
      { extra: true },
    ])
      expect(() => decodeSpeechSnapshot({ ...state, ...change })).toThrow();
    expect(decodeSpeechError('model_missing')).toBe('model_missing');
    expect(() => decodeSpeechError('unknown')).toThrow();
    expect(decodeSpeechRequest({ version: 1 })).toEqual({ version: 1 });
    expect(
      decodeSpeechStopRequest({ version: 1, epoch: '18446744073709551615' })
        .epoch,
    ).toBe('18446744073709551615');
    expect(() =>
      decodeSpeechStopRequest({ version: 1, epoch: '-1' }),
    ).toThrow();
    expect(() =>
      decodeSpeechRequest({ version: 1, command: 'exec' }),
    ).toThrow();
  });
});
