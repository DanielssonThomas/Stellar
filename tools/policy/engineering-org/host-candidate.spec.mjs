import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { sealInertCandidate, verifyInertCandidate } from './host-candidate.mjs';

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function fixture(t, allowedPaths = ['nested/widget.txt', 'new.txt']) {
  const directory = await mkdtemp(join(tmpdir(), 'stellar-host-candidate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'source');
  await mkdir(join(source, 'nested'), { recursive: true });
  await writeFile(join(source, 'nested/widget.txt'), 'before\n');
  git(source, 'init', '-b', 'develop');
  git(source, 'add', '--all');
  git(
    source,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '-m',
    'fixture',
  );
  const facts = {
    issue: { number: 42 },
    claim: { worktreePath: source, sessionId: 'candidate-session' },
    sourceRevision: git(source, 'rev-parse', 'HEAD'),
    scope: { allowedPaths },
  };
  return { directory, source, root: join(directory, 'candidate'), facts };
}

test('seals generic allowed changes into a Git snapshot without altering the source worktree', async (t) => {
  const context = await fixture(t);
  const candidate = await sealInertCandidate({
    ...context,
    changes: [
      { path: 'nested/widget.txt', content: 'one\ntwo\n' },
      { path: 'new.txt', content: '' },
    ],
  });
  assert.equal(candidate.issueNumber, 42);
  assert.equal(candidate.sessionId, 'candidate-session');
  assert.equal(candidate.sourceRevision, context.facts.sourceRevision);
  assert.match(candidate.gitCommit, /^[a-f0-9]{40}$/);
  assert.deepEqual(
    candidate.files.map(({ path, status, baseLineCount, headLineCount }) => ({
      path,
      status,
      baseLineCount,
      headLineCount,
    })),
    [
      {
        path: 'nested/widget.txt',
        status: 'modified',
        baseLineCount: 1,
        headLineCount: 2,
      },
      { path: 'new.txt', status: 'added', baseLineCount: 0, headLineCount: 0 },
    ],
  );
  await verifyInertCandidate(context.root, candidate);
  assert.equal(
    await readFile(join(context.source, 'nested/widget.txt'), 'utf8'),
    'before\n',
  );
  assert.equal(git(context.source, 'status', '--porcelain'), '');
});

test('rejects modified candidate bytes, altered digest and nonexistent snapshot commits', async (t) => {
  const context = await fixture(t);
  const candidate = await sealInertCandidate({
    ...context,
    changes: [{ path: 'nested/widget.txt', content: 'after\n' }],
  });
  await assert.rejects(
    verifyInertCandidate(context.root, {
      ...candidate,
      contentDigest: '0'.repeat(64),
    }),
  );
  await assert.rejects(
    verifyInertCandidate(context.root, {
      ...candidate,
      gitCommit: '0'.repeat(40),
    }),
  );
  const altered = structuredClone(candidate);
  altered.files[0].content = 'changed\n';
  await assert.rejects(verifyInertCandidate(context.root, altered));
  await writeFile(join(context.root, 'nested/widget.txt'), 'changed\n');
  await assert.rejects(verifyInertCandidate(context.root, candidate));
});

test('rejects empty, duplicate, excessive, out-of-scope and oversized change sets', async (t) => {
  const context = await fixture(t);
  for (const changes of [
    [],
    [
      { path: 'new.txt', content: 'a' },
      { path: 'new.txt', content: 'b' },
    ],
    Array.from({ length: 17 }, (_, index) => ({
      path: `${index}.txt`,
      content: '',
    })),
    [{ path: 'elsewhere.txt', content: '' }],
    [{ path: 'new.txt', content: 'é'.repeat(16_385) }],
  ]) {
    await assert.rejects(sealInertCandidate({ ...context, changes }));
  }
});

test('rejects traversal, Git-directory aliases and Windows device paths even inside the proposed allowlist', async (t) => {
  const unsafe = [
    '../escape.txt',
    '/absolute.txt',
    'a//b',
    '.git/config',
    '.GIT/config',
    '.git./config',
    'nested/../escape.txt',
    'nested/file.',
    'CON',
    'nested/NUL.txt',
    'new.txt:stream',
  ];
  const context = await fixture(t, unsafe);
  for (const path of unsafe) {
    await assert.rejects(
      sealInertCandidate({
        ...context,
        changes: [{ path, content: 'untrusted' }],
      }),
      path,
    );
    await assert.rejects(lstat(context.root), { code: 'ENOENT' });
  }
});

test('rejects case-insensitive candidate path collisions before filesystem writes', async (t) => {
  const context = await fixture(t, ['Name.txt', 'name.txt']);
  await assert.rejects(
    sealInertCandidate({
      ...context,
      changes: [
        { path: 'Name.txt', content: 'first' },
        { path: 'name.txt', content: 'second' },
      ],
    }),
  );
  await assert.rejects(lstat(context.root), { code: 'ENOENT' });
});

test('does not reuse an existing candidate directory', async (t) => {
  const context = await fixture(t);
  await mkdir(context.root);
  await writeFile(join(context.root, 'preserve.txt'), 'keep');
  await assert.rejects(
    sealInertCandidate({
      ...context,
      changes: [{ path: 'new.txt', content: 'new' }],
    }),
  );
  assert.equal(
    await readFile(join(context.root, 'preserve.txt'), 'utf8'),
    'keep',
  );
});

test('ignores ambient Git routing variables for source inspection and snapshot writes', async (t) => {
  const context = await fixture(t);
  const names = [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
  ];
  const previous = Object.fromEntries(
    names.map((name) => [name, process.env[name]]),
  );
  try {
    for (const name of names)
      process.env[name] = join(context.directory, `invalid-${name}`);
    const candidate = await sealInertCandidate({
      ...context,
      changes: [{ path: 'nested/widget.txt', content: 'after\n' }],
    });
    assert.equal(candidate.files[0].status, 'modified');
    assert.equal(candidate.files[0].baseLineCount, 1);
    await verifyInertCandidate(context.root, candidate);
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});
