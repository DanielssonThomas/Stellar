import { readFileSync } from 'node:fs';
import { crc32, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { optimizePng } from './optimize-png.mjs';

function chunks(source) {
  const result = [];
  for (let offset = 8; offset < source.length; ) {
    const size = source.readUInt32BE(offset);
    result.push({
      type: source.toString('ascii', offset + 4, offset + 8),
      data: source.subarray(offset + 8, offset + 8 + size),
      checksumData: source.subarray(offset + 4, offset + 8 + size),
      crc: source.readUInt32BE(offset + 8 + size),
    });
    offset += size + 12;
  }
  return result;
}

describe('lossless PNG recompression', () => {
  it('preserves every filtered scanline and non-image chunk with valid output checksums', () => {
    const source = readFileSync(
      new URL('./production-v1/layers/gold-body.png', import.meta.url),
    );
    const optimized = optimizePng(source);
    const before = chunks(source),
      after = chunks(optimized);
    const scanlines = (list) =>
      inflateSync(
        Buffer.concat(
          list
            .filter((chunk) => chunk.type === 'IDAT')
            .map((chunk) => chunk.data),
        ),
      );
    expect(scanlines(after).equals(scanlines(before))).toBe(true);
    expect(after.filter((chunk) => chunk.type !== 'IDAT')).toEqual(
      before.filter((chunk) => chunk.type !== 'IDAT'),
    );
    for (const chunk of after)
      expect(crc32(chunk.checksumData)).toBe(chunk.crc);
    expect(optimized.length).toBeLessThanOrEqual(source.length);
  });
  it('rejects invalid or truncated data instead of writing corrupt files', () => {
    expect(() => optimizePng(Buffer.from('not a PNG'))).toThrow();
    const source = readFileSync(
      new URL('./production-v1/layers/gold-body.png', import.meta.url),
    );
    expect(() => optimizePng(source.subarray(0, 15))).toThrow();
  });
});
