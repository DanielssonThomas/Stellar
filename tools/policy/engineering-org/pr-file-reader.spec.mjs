import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { response } from '../integration-fixtures.mjs';
import { createPrFileReader } from './pr-file-reader.mjs';

const revision = 'a'.repeat(40);
function blob(bytes = Buffer.from('value\n')) {
  return {
    type: 'file',
    encoding: 'base64',
    size: bytes.length,
    content: bytes.toString('base64'),
    sha: createHash('sha1')
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest('hex'),
  };
}

test('reads only the exact escaped path/revision and binds API contents to manifest blob identity', async () => {
  const file = blob();
  const calls = [];
  const reader = createPrFileReader(
    async (route) => {
      calls.push(route);
      return response(200, file);
    },
    {
      headSha: revision,
      files: [{ filename: 'src/file name.mjs', sha: file.sha }],
    },
  );
  assert.equal(await reader('src/file name.mjs', revision), 'value\n');
  assert.deepEqual(calls, [`/contents/src/file%20name.mjs?ref=${revision}`]);
  await assert.rejects(
    createPrFileReader(async () => response(200, file), {
      headSha: revision,
      files: [{ filename: 'source.mjs', sha: 'b'.repeat(40) }],
    })('source.mjs', revision),
    /complete changed-file evidence/,
  );
});

test('rejects foreign paths, malformed encoding, oversized/non-file content and invalid UTF8', async () => {
  let calls = 0;
  const reader = createPrFileReader(async () => {
    calls += 1;
    return response(200, blob());
  });
  for (const file of ['../file', '/file', 'src\\file'])
    await assert.rejects(reader(file, revision));
  assert.equal(calls, 0);
  for (const change of [
    { content: 'invalid@base64' },
    { type: 'symlink' },
    { size: 32769 },
    { sha: 'b'.repeat(40) },
    blob(Buffer.from([0xc0])),
  ]) {
    const value = { ...blob(), ...change };
    await assert.rejects(
      createPrFileReader(async () => response(200, value))(
        'source.mjs',
        revision,
      ),
    );
  }
});
