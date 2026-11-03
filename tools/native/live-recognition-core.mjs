/** The collector accepts only the canonical PCM WAV emitted by its own client. */
export function validRecording(bytes) {
  return (
    Buffer.isBuffer(bytes) &&
    bytes.length >= 6444 &&
    bytes.length <= 1440044 &&
    bytes.length % 2 === 0 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.readUInt32LE(4) === bytes.length - 8 &&
    bytes.toString('ascii', 8, 12) === 'WAVE' &&
    bytes.toString('ascii', 12, 16) === 'fmt ' &&
    bytes.readUInt32LE(16) === 16 &&
    bytes.readUInt16LE(20) === 1 &&
    bytes.readUInt16LE(22) === 1 &&
    bytes.readUInt32LE(24) === 16000 &&
    bytes.readUInt32LE(28) === 32000 &&
    bytes.readUInt16LE(32) === 2 &&
    bytes.readUInt16LE(34) === 16 &&
    bytes.toString('ascii', 36, 40) === 'data' &&
    bytes.readUInt32LE(40) === bytes.length - 44
  );
}
