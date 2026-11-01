import { createHash } from 'node:crypto';
import { readJson } from '../integration-github.mjs';
import { isRevision, requireValue } from './planning-evidence.mjs';

export function createPrFileReader(request, expected = {}) {
  return async (filename, revision) => {
    requireValue(
      typeof filename === 'string' &&
        filename.length <= 512 &&
        !filename.startsWith('/') &&
        !filename.includes('\\') &&
        filename
          .split('/')
          .every((part) => part && part !== '.' && part !== '..') &&
        isRevision(revision),
      'A bounded PR path and exact revision are required.',
    );
    const resource = filename.split('/').map(encodeURIComponent).join('/');
    const file = await readJson(
      request,
      `/contents/${resource}?ref=${revision}`,
    );
    requireValue(
      file?.type === 'file' &&
        file.encoding === 'base64' &&
        typeof file.content === 'string' &&
        file.content.length <= 48_000 &&
        Number.isSafeInteger(file.size) &&
        file.size >= 0 &&
        file.size <= 32_768 &&
        isRevision(file.sha),
      'PR content is unavailable, non-text or oversized.',
    );
    const encoded = file.content.replace(/[\r\n]/g, '');
    const bytes = Buffer.from(encoded, 'base64');
    requireValue(
      bytes.toString('base64') === encoded && bytes.length === file.size,
      'PR content encoding or size is invalid.',
    );
    const sha = createHash('sha1')
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest('hex');
    requireValue(
      sha === file.sha,
      'PR content does not match its Git blob identity.',
    );
    if (revision === expected.headSha)
      requireValue(
        expected.files?.some(
          (entry) => entry.filename === filename && entry.sha === sha,
        ),
        'PR content blob differs from its complete changed-file evidence.',
      );
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  };
}
