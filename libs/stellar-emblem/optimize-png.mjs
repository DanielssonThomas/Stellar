import { crc32, deflateSync, inflateSync } from 'node:zlib';

export function optimizePng(source) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!source.subarray(0, 8).equals(signature))
    throw new Error('Invalid PNG signature');
  const chunks = [];
  const imageData = [];
  for (let offset = 8; offset < source.length; ) {
    if (offset + 12 > source.length) throw new Error('Truncated PNG chunk');
    const length = source.readUInt32BE(offset);
    const end = offset + length + 12;
    if (end > source.length) throw new Error('Truncated PNG data');
    const type = source.toString('ascii', offset + 4, offset + 8);
    chunks.push({ type, data: source.subarray(offset, end) });
    if (type === 'IDAT') imageData.push(source.subarray(offset + 8, end - 4));
    offset = end;
  }
  if (!imageData.length) throw new Error('Missing PNG image data');
  // Recompress the original filtered scanlines; never decode or alter pixels.
  const compressed = deflateSync(inflateSync(Buffer.concat(imageData)), {
    level: 9,
  });
  const idat = Buffer.alloc(compressed.length + 12);
  idat.writeUInt32BE(compressed.length, 0);
  idat.write('IDAT', 4, 'ascii');
  compressed.copy(idat, 8);
  idat.writeUInt32BE(crc32(idat.subarray(4, idat.length - 4)), idat.length - 4);
  let written = false;
  const result = Buffer.concat([
    signature,
    ...chunks.flatMap((chunk) => {
      if (chunk.type !== 'IDAT') return [chunk.data];
      if (written) return [];
      written = true;
      return [idat];
    }),
  ]);
  return result.length < source.length ? result : source;
}
