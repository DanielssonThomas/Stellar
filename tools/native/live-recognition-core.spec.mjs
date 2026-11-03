import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validRecording } from './live-recognition-core.mjs';

function fixture(length = 6444) {
  const bytes = Buffer.alloc(length);
  bytes.write('RIFF');
  bytes.writeUInt32LE(length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24);
  bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(length - 44, 40);
  return bytes;
}

test('accepts only bounded canonical mono PCM16 WAV recordings', () => {
  assert.equal(validRecording(fixture()), true);
  assert.equal(validRecording(fixture(1440044)), true);
  for (const length of [0, 44, 6442, 6445, 1440046])
    assert.equal(
      validRecording(length < 44 ? Buffer.alloc(length) : fixture(length)),
      false,
    );
  for (const at of [0, 4, 8, 12, 16, 20, 22, 24, 28, 32, 34, 36, 40]) {
    const bytes = fixture();
    bytes[at] ^= 1;
    assert.equal(
      validRecording(bytes),
      false,
      `Header field ${at} must be checked`,
    );
  }
});
