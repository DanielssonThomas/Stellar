import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { digest, requireValue, isRevision } from './planning-evidence.mjs';

function git(root, args, input, trim = true) {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.toUpperCase().startsWith('GIT_'),
    ),
  );
  const output = execFileSync(
    'git',
    ['-C', root, '-c', 'core.hooksPath=', '-c', 'core.autocrlf=false', ...args],
    {
      input,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 256 * 1024,
      env: {
        ...environment,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_CONFIG_COUNT: '0',
        GIT_NO_REPLACE_OBJECTS: '1',
        GIT_AUTHOR_NAME: 'Stellar Inert Host',
        GIT_AUTHOR_EMAIL: 'inert@example.invalid',
        GIT_COMMITTER_NAME: 'Stellar Inert Host',
        GIT_COMMITTER_EMAIL: 'inert@example.invalid',
        GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
        GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  return trim ? output.trim() : output;
}

const validPath = (name) =>
  typeof name === 'string' &&
  /^[a-zA-Z0-9._/-]+$/.test(name) &&
  !name.startsWith('/') &&
  name
    .split('/')
    .every(
      (part) =>
        part &&
        !part.endsWith('.') &&
        part.toLowerCase() !== '.git' &&
        !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part),
    );
const lines = (content) =>
  content.length ? content.replace(/\r?\n$/, '').split(/\r?\n/).length : 0;

export async function sealInertCandidate({ root, facts, changes }) {
  requireValue(
    Array.isArray(changes) &&
      changes.length > 0 &&
      changes.length <= 16 &&
      new Set(changes.map((entry) => String(entry?.path).toLowerCase()))
        .size === changes.length,
    'Candidate must contain bounded unique changes.',
  );
  requireValue(
    isRevision(facts.sourceRevision) &&
      git(facts.claim.worktreePath, [
        'rev-parse',
        '--verify',
        `${facts.sourceRevision}^{commit}`,
      ]) === facts.sourceRevision,
    'Candidate source revision is unavailable.',
  );
  const files = [];
  for (const change of changes) {
    requireValue(
      validPath(change?.path) &&
        facts.scope.allowedPaths.includes(change.path) &&
        typeof change.content === 'string' &&
        Buffer.byteLength(change.content) <= 32_768,
      'Candidate change exceeds trusted scope.',
    );
    let baseline = '';
    let status = 'modified';
    if (
      git(facts.claim.worktreePath, [
        'ls-tree',
        '--name-only',
        facts.sourceRevision,
        '--',
        change.path,
      ])
    )
      baseline = git(
        facts.claim.worktreePath,
        ['show', `${facts.sourceRevision}:${change.path}`],
        undefined,
        false,
      );
    else status = 'added';
    files.push({
      path: change.path,
      content: change.content,
      status,
      baseLineCount: lines(baseline),
      headLineCount: lines(change.content),
    });
  }
  await mkdir(root, { recursive: false });
  for (const file of files) {
    const target = path.join(root, file.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content, { flag: 'wx' });
  }
  git(root, [
    'init',
    '--quiet',
    '--template=',
    '--initial-branch=inert-candidate',
  ]);
  git(root, ['add', '--all']);
  const tree = git(root, ['write-tree']);
  const gitCommit = git(
    root,
    ['commit-tree', tree],
    'Inert candidate snapshot\n',
  );
  requireValue(isRevision(gitCommit), 'Candidate snapshot commit is invalid.');
  const candidate = {
    mode: 'inert',
    issueNumber: facts.issue.number,
    sessionId: facts.claim.sessionId,
    sourceRevision: facts.sourceRevision,
    gitCommit,
    contentDigest: digest(files),
    files,
  };
  await verifyInertCandidate(root, candidate);
  return candidate;
}

export async function verifyInertCandidate(root, candidate) {
  requireValue(
    candidate.mode === 'inert' &&
      isRevision(candidate.gitCommit) &&
      digest(candidate.files) === candidate.contentDigest,
    'Candidate identity or digest changed.',
  );
  const tracked = git(root, [
    'ls-tree',
    '-r',
    '--name-only',
    candidate.gitCommit,
  ])
    .split('\n')
    .filter(Boolean)
    .sort();
  requireValue(
    digest(tracked) === digest(candidate.files.map((file) => file.path).sort()),
    'Candidate Git tree changed.',
  );
  for (const file of candidate.files) {
    requireValue(validPath(file.path), 'Candidate path is invalid.');
    const target = path.join(root, file.path);
    const info = await lstat(target);
    requireValue(
      info.isFile() && !info.isSymbolicLink() && info.size <= 32_768,
      'Candidate file is unsafe.',
    );
    const committed = git(
      root,
      ['show', `${candidate.gitCommit}:${file.path}`],
      undefined,
      false,
    );
    requireValue(
      committed === file.content &&
        (await readFile(target, 'utf8')) === file.content,
      'Candidate bytes no longer match the snapshot commit.',
    );
  }
  return candidate;
}
