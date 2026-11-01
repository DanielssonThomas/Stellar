import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, readdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

export async function plainEntry(file, kind, allowMissing = false) {
  let entry;
  try {
    entry = await lstat(file);
  } catch (error) {
    if (allowMissing && error.code === 'ENOENT') return false;
    throw error;
  }
  if (
    entry.isSymbolicLink() ||
    (kind === 'file' && !entry.isFile()) ||
    (kind === 'directory' && !entry.isDirectory())
  )
    throw new Error(`Identity path has an unsafe file type: ${file}`);
  return true;
}

export async function plainParents(root, destination) {
  let ancestor = path.parse(root).root;
  await plainEntry(ancestor, 'directory');
  for (const part of path
    .relative(ancestor, root)
    .split(path.sep)
    .filter(Boolean)) {
    ancestor = path.join(ancestor, part);
    await plainEntry(ancestor, 'directory');
  }
  const relative = path.relative(root, path.dirname(destination));
  if (relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error('Identity destination escapes its Hermes root.');
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    await plainEntry(current, 'directory', true);
  }
}

export async function plainTree(directory) {
  if (!(await plainEntry(directory, 'directory', true))) return;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) await plainTree(child);
    else await plainEntry(child, 'file');
  }
}

export async function installIdentityFile(source, destination, force) {
  await plainEntry(destination, 'file', true);
  if (!force) {
    await copyFile(source, destination, constants.COPYFILE_EXCL);
    return;
  }
  const staged = path.join(
    path.dirname(destination),
    `.stellar-identity-${randomUUID()}.tmp`,
  );
  try {
    await copyFile(source, staged, constants.COPYFILE_EXCL);
    await rename(staged, destination);
  } finally {
    await unlink(staged).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
