import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const allowedTypes = new Set([
  'feat',
  'fix',
  'refactor',
  'test',
  'docs',
  'chore',
  'build',
  'ci',
]);
const headerPattern =
  /^\[#([1-9][0-9]*)\] ([a-z]+)(?:\(([a-z0-9][a-z0-9._/-]*)\))?: (.+)$/;
const forbiddenSubjects = new Set([
  'update',
  'updates',
  'changes',
  'stuff',
  'misc',
  'wip',
  'fix',
  'test',
]);
const emojiPattern =
  /\p{Extended_Pictographic}|\p{Regional_Indicator}|\uFE0F|\u20E3/u;

export function validateCommitMessage(message) {
  const normalized = message.trim();
  const header = normalized.split(/\r?\n/)[0];
  const match = header.match(headerPattern);
  if (!match)
    return 'Subject must begin with [#<issue-id>] and follow conventional commit syntax.';
  if (!allowedTypes.has(match[2]))
    return `Unsupported commit type: ${match[2]}.`;
  if (
    match[4].length < 5 ||
    forbiddenSubjects.has(match[4].trim().toLowerCase())
  )
    return 'Use a descriptive commit subject.';
  if (emojiPattern.test(normalized))
    return 'Commit messages must not contain emoji characters.';
  if (header.length > 120)
    return 'Commit subject must not exceed 120 characters.';
  return null;
}

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error('Pass the commit message file path.');
  const error = validateCommitMessage(await readFile(file, 'utf8'));
  if (error) throw new Error(error);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
