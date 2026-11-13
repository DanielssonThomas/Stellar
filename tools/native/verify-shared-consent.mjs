import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Immutable, disposable TEST graph only. No app/OS verifier is launched.
const producerRevision = '160cba946e5ef5f7d32855ebb8f48d710f20b15b';
const consumerRevision = 'c1999127a1e1dfdad68a76140c1288fcef923522';
const root = resolve(import.meta.dirname, '../..');
const consumer = resolve(process.argv[2] ?? '../stellar-issue-299');
const python = process.env.STELLAR_FIXTURE_PYTHON;
const scratch = mkdtempSync(join(tmpdir(), 'stellar339-shared-consent-'));
const fixture = join(scratch, 'fixture');
const reportPath = join(
  root,
  'artifacts/issue-339',
  `shared-consent-${Date.now()}.json`,
);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const report = {
  producerRevision,
  consumerRevision,
  scratch,
  operational: false,
  scriptSha256: sha(readFileSync(import.meta.filename)),
  exports: [],
  checks: [],
};

function command(file, args, cwd = scratch, options = {}) {
  const result = spawnSync(report.tools?.[file]?.path ?? file, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${file} failed: ${result.error?.message ?? result.stderr}`,
    );
  return result.stdout;
}

function git(repo, args) {
  return command('git', [
    '-c',
    'core.autocrlf=false',
    '-c',
    `safe.directory=${repo}`,
    '-C',
    repo,
    ...args,
  ]);
}

function exportRevision(repo, revision, paths, name) {
  const entries = git(repo, ['ls-tree', '-r', revision, '--', ...paths]);
  if (!entries.trim()) throw new Error('Empty immutable export');
  for (const entry of entries.trimEnd().split('\n')) {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(entry);
    if (
      !match ||
      !/^[a-zA-Z0-9_.@/ -]+$/.test(match[3]) ||
      match[3].split('/').some((part) => part === '..' || part === '') ||
      match[3].startsWith('/')
    )
      throw new Error(`Nonregular/unsafe Git entry refused: ${entry}`);
  }
  const archive = join(scratch, `${name}.tar`);
  git(repo, [
    'archive',
    '--format=tar',
    `--output=${archive}`,
    revision,
    ...paths,
  ]);
  report.exports.push({
    revision,
    paths,
    archiveSha256: sha(readFileSync(archive)),
    entriesSha256: sha(entries),
    tree: git(repo, ['rev-parse', `${revision}^{tree}`]).trim(),
  });
  command('tar', ['-xf', archive, '-C', fixture]);
}

function edit(path, change) {
  const destination = join(fixture, path);
  const before = readFileSync(destination, 'utf8');
  const changed = change(before.replaceAll('\r\n', '\n'));
  const after = before.includes('\r\n')
    ? changed.replaceAll('\n', '\r\n')
    : changed;
  if (before === after)
    throw new Error(`Missing exact paired-edit precondition: ${path}`);
  writeFileSync(destination, after);
}

function packageBlocks(lock) {
  return lock
    .replaceAll('\r\n', '\n')
    .split('[[package]]')
    .slice(1)
    .map((text) => {
      const name = /^name = "([^"]+)"$/m.exec(text)?.[1];
      return { name, text: text.trim() };
    });
}

function check(name, file, args) {
  process.stdout.write(`Checking ${name}\n`);
  const executable = report.tools?.[file]?.path ?? file;
  const result = spawnSync(executable, args, {
    cwd: fixture,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      CARGO_NET_OFFLINE: 'true',
      CARGO_TARGET_DIR:
        process.env.STELLAR_FIXTURE_TARGET ?? join(scratch, 'target'),
      RUST_TEST_THREADS: '2',
      NX_DAEMON: 'false',
      NX_WORKSPACE_DATA_DIRECTORY: join(scratch, 'nx-data'),
      PATH: python
        ? `${resolve(python, '..')};${process.env.PATH}`
        : process.env.PATH,
    },
  });
  const log = join(scratch, `${name}.log`);
  writeFileSync(log, `${result.stdout ?? ''}${result.stderr ?? ''}`);
  report.checks.push({
    name,
    file,
    executable,
    args,
    status: result.status,
    error: result.error?.message,
    log,
    logSha256: sha(readFileSync(log)),
  });
  if (result.error || result.status !== 0)
    throw new Error(`${name} failed; see ${log}`);
}

try {
  if (!python)
    throw new Error(
      'Set STELLAR_FIXTURE_PYTHON to an existing qualified interpreter; no install/alias fallback',
    );
  report.python = { path: resolve(python), sha256: sha(readFileSync(python)) };
  report.python.version = command(python, ['--version'], root).trim();
  report.target = 'x86_64-pc-windows-msvc';
  report.tools = {};
  for (const file of ['git', 'tar', 'cargo', 'rustc', 'node']) {
    const path =
      file === 'node'
        ? process.execPath
        : command('where.exe', [file]).trim().split(/\r?\n/)[0];
    report.tools[file] = {
      path,
      sha256: sha(readFileSync(path)),
      version: command(
        path,
        [file === 'cargo' || file === 'rustc' ? '-Vv' : '--version'],
        root,
      ).trim(),
    };
  }
  mkdirSync(fixture);
  exportRevision(consumer, consumerRevision, [], 'consumer');
  exportRevision(
    root,
    producerRevision,
    [
      'Cargo.toml',
      'Cargo.lock',
      'rust-toolchain.toml',
      'tools/native/consent-broker',
      'tools/native/rust-size',
    ],
    'producer',
  );
  const beforeLock = readFileSync(join(fixture, 'Cargo.lock'), 'utf8');
  report.toolchainSha256 = sha(
    readFileSync(join(fixture, 'rust-toolchain.toml')),
  );
  if (process.env.STELLAR_FIXTURE_TARGET) {
    mkdirSync(process.env.STELLAR_FIXTURE_TARGET, { recursive: true });
    symlinkSync(
      resolve(process.env.STELLAR_FIXTURE_TARGET),
      join(fixture, 'target'),
      'junction',
    );
  }
  // Local fixture Git inventory supports the existing AST size tool and exact diff.
  command('git', ['init', '--quiet'], fixture);
  command('git', ['config', 'core.autocrlf', 'false'], fixture);
  command('git', ['-c', 'core.autocrlf=false', 'add', '--all'], fixture);
  edit('Cargo.toml', (text) =>
    text.replace(
      '"tools/native/consent-broker"]',
      '"tools/native/consent-broker", "tools/native/consent-ui"]',
    ),
  );
  edit('tools/native/consent-ui/Cargo.toml', (text) =>
    text.replace(
      '\n# Independently testable inactive UI boundary; shared workspace wiring is #339-owned.\n[workspace]\n',
      '',
    ),
  );
  edit('apps/stellar-desktop/src-tauri/Cargo.toml', (text) => {
    if (text.includes('[dev-dependencies]'))
      throw new Error('Unexpected existing dev-dependencies');
    return `${text}\n[dev-dependencies]\nstellar-consent-broker = { path = "../../../tools/native/consent-broker" }\nstellar-consent-ui = { path = "../../../tools/native/consent-ui" }\n`;
  });
  edit('apps/stellar-desktop/src-tauri/src/ivy/mod.rs', (text) => {
    if (text.includes('mod native_consent_client;'))
      throw new Error('Client already wired');
    return text.replace(
      'mod observation;',
      '#[cfg(test)]\nmod native_consent_client;\nmod observation;',
    );
  });
  check('lock', 'cargo', [
    'metadata',
    '--offline',
    '--format-version=1',
    '--filter-platform',
    'x86_64-pc-windows-msvc',
  ]);
  const afterLock = readFileSync(join(fixture, 'Cargo.lock'), 'utf8');
  const before = packageBlocks(beforeLock),
    after = packageBlocks(afterLock);
  const added = after.filter(
    (item) => !before.some((old) => old.text === item.text),
  );
  const removed = before.filter(
    (item) => !after.some((next) => next.text === item.text),
  );
  if (
    added.length !== 2 ||
    removed.length !== 1 ||
    removed[0].name !== 'stellar-desktop' ||
    !added.some(
      (item) => item.text === 'name = "stellar-consent-ui"\nversion = "0.1.0"',
    ) ||
    !added.some(
      (item) =>
        item.name === 'stellar-desktop' &&
        item.text ===
          removed[0].text.replace(
            ' "sha2",\n',
            ' "sha2",\n "stellar-consent-broker",\n "stellar-consent-ui",\n',
          ),
    )
  )
    throw new Error('Unexpected lock package/dependency/checksum delta');
  report.lockSha256 = sha(afterLock);
  report.rootPatch = join(scratch, 'producer-root.patch');
  writeFileSync(
    report.rootPatch,
    command('git', ['diff', '--', 'Cargo.toml', 'Cargo.lock'], fixture),
  );
  report.pairedPatch = join(scratch, 'paired-test-only.patch');
  writeFileSync(
    report.pairedPatch,
    command(
      'git',
      [
        'diff',
        '--',
        'Cargo.toml',
        'Cargo.lock',
        'tools/native/consent-ui/Cargo.toml',
        'apps/stellar-desktop/src-tauri/Cargo.toml',
        'apps/stellar-desktop/src-tauri/src/ivy/mod.rs',
      ],
      fixture,
    ),
  );
  report.rootPatchSha256 = sha(readFileSync(report.rootPatch));
  report.pairedPatchSha256 = sha(readFileSync(report.pairedPatch));
  check('python-fixture', python, [
    '-I',
    '-B',
    '-c',
    'import sys; print(sys.version); print("inert-fixture-ready",flush=True)',
  ]);
  symlinkSync(
    join(root, 'node_modules'),
    join(fixture, 'node_modules'),
    'junction',
  );
  check('frontend-build', 'node', [
    'node_modules/nx/bin/nx.js',
    'build',
    'stellar-desktop',
    '--skip-nx-cache',
  ]);
  check('fmt', 'cargo', ['fmt', '--all', '--', '--check']);
  check('clippy', 'cargo', [
    'clippy',
    '--offline',
    '--locked',
    '--workspace',
    '--all-targets',
    '--',
    '-D',
    'warnings',
  ]);
  check('tests', 'cargo', ['test', '--offline', '--locked', '--workspace']);
  check('bindings', 'node', ['tools/native/cargo.mjs', 'contract-check']);
  check('size', 'cargo', [
    'run',
    '--offline',
    '--locked',
    '--quiet',
    '-p',
    'stellar-rust-size',
    '--',
    fixture,
  ]);
  check('diff', 'git', ['diff', '--check']);
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = error.message;
  process.exitCode = 1;
} finally {
  mkdirSync(resolve(reportPath, '..'), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(
    JSON.stringify({
      reportPath,
      passed: report.passed,
      failure: report.failure,
      scratch,
    }),
  );
}
