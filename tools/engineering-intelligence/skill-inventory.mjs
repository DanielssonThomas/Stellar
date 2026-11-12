import { createHash } from 'node:crypto';
import { openSync, closeSync, readSync, readdirSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { Tiktoken } from 'js-tiktoken/lite';
import encoding from 'js-tiktoken/ranks/o200k_base';
import { recordSkill } from './history.mjs';

const maxSkillBytes = 65_536;
export const staticTokenizer = 'o200k_base/js-tiktoken-1.0.21';

export function inventorySkills(
  dbPath,
  directory,
  recordedAt = new Date().toISOString(),
) {
  const tokenizer = new Tiktoken(encoding);
  const entries = readdirSync(directory, { withFileTypes: true }).filter(
    (entry) =>
      entry.isDirectory() && /^[a-z0-9][a-z0-9-]{0,95}$/.test(entry.name),
  );
  if (entries.length > 256) throw new Error('Too many skills to inventory');
  const measured = [];
  for (const entry of entries) {
    const file = path.join(directory, entry.name, 'SKILL.md');
    const metadata = lstatSync(file, { throwIfNoEntry: false });
    if (!metadata?.isFile() || metadata.size > maxSkillBytes) continue;
    const fd = openSync(file, 'r');
    const bytes = Buffer.alloc(maxSkillBytes + 1);
    let length = 0;
    try {
      while (length < bytes.length) {
        const count = readSync(fd, bytes, length, bytes.length - length);
        if (count === 0) break;
        length += count;
      }
    } finally {
      closeSync(fd);
    }
    if (length > maxSkillBytes) continue;
    const content = bytes.subarray(0, length);
    const contentHash = createHash('sha256').update(content).digest('hex');
    const staticTokens = tokenizer.encode(
      content.toString('utf8'),
      [],
      [],
    ).length;
    const version = contentHash.slice(0, 24);
    recordSkill(dbPath, {
      skill: entry.name,
      version,
      contentHash,
      recordedAt,
      staticTokens,
      tokenizer: staticTokenizer,
    });
    measured.push({ skill: entry.name, version, staticTokens });
  }
  return measured;
}
