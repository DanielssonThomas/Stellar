import { describe, expect, it } from 'vitest';
import { decodeBrowserEvent, decodeImagePreview } from './media-codec';
describe('media wire validation', () => {
  it('rejects executable image results, excessive dimensions and unknown browser events', () => {
    for (const data_uri of [
      'data:image/svg+xml;base64,AAAA',
      'https://example.com/x',
      'file:///secret',
    ])
      expect(() =>
        decodeImagePreview({ data_uri, width: 100, height: 100 }),
      ).toThrow();
    expect(() =>
      decodeImagePreview({
        data_uri: 'data:image/png;base64,AAAA',
        width: 1601,
        height: 10,
      }),
    ).toThrow();
    expect(() =>
      decodeBrowserEvent({
        id: '0'.repeat(36),
        url: 'https://example.com',
        state: 'execute',
      }),
    ).toThrow();
    expect(
      decodeImagePreview({
        data_uri: 'data:image/png;base64,AAAA',
        width: 10,
        height: 10,
      }).width,
    ).toBe(10);
  });
});
