import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const producerRevision = '160cba946e5ef5f7d32855ebb8f48d710f20b15b';
const consumerBase = 'c1999127a1e1dfdad68a76140c1288fcef923522';
const brokerTree = 'bdadecbb921df6fee570235b0cd896ffcc33aa50';
const root = resolve(import.meta.dirname, '../..');
const producer = resolve(process.argv[2] ?? '../stellar-issue-339');
const scratch = mkdtempSync(join(tmpdir(), 'stellar299-wiring-'));
const fixture = join(scratch, 'integration');
const bundle = join(root, 'artifacts/issue-299', `paired-wiring-${Date.now()}`);
mkdirSync(bundle, { recursive: true });
mkdirSync(fixture);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const normalized = (bytes, file) =>
  /\.(rs|toml|json|py|mjs|js|md|txt|yaml|yml|ts|html|css|xml|svg|plist)$/.test(
    file,
  )
    ? Buffer.from(bytes.toString().replaceAll('\r\n', '\n'))
    : bytes;
const report = {
  producerRevision,
  consumerBase,
  brokerTree,
  scratch,
  fixture,
  verifierSha256: sha(readFileSync(import.meta.filename)),
  consumerFiles: {},
  rootFiles: {},
  checks: [],
  productionEnabled: false,
  patchLineEndings: 'LF; per-command core.autocrlf=false in fixture only',
};
const env = { ...process.env, CARGO_TARGET_DIR: join(root, 'target') };
const ownRoot = Object.fromEntries(
  ['Cargo.toml', 'Cargo.lock'].map((file) => [
    file,
    sha(readFileSync(join(root, file))),
  ]),
);
report.ownRootBefore = ownRoot;

function rendererSnapshot(source, destination, prefix = '') {
  for (const item of readdirSync(source, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const input = join(source, item.name),
      output = join(destination, item.name);
    const key = prefix + item.name;
    if (item.isDirectory()) rendererSnapshot(input, output, `${key}/`);
    else if (item.isFile()) {
      const bytes = readFileSync(input);
      put(output, bytes);
      report.cachedRenderer[key] = sha(bytes);
    } else throw new Error('Non-regular cached renderer input refused');
  }
}

function run(file, args, cwd = fixture, accepted = [0]) {
  const result = spawnSync(file, args, {
    cwd,
    env,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || !accepted.includes(result.status))
    throw new Error(
      `${file} failed: ${result.error?.message ?? result.stderr}`,
    );
  return result.stdout;
}
function git(repo, args, cwd = fixture, accepted) {
  return run(
    'git',
    [
      '-c',
      `safe.directory=${repo}`,
      '-c',
      'core.autocrlf=false',
      '-C',
      repo,
      ...args,
    ],
    cwd,
    accepted,
  );
}
function put(file, bytes) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
}
function recordCheck(name, file, args) {
  const result = spawnSync(file, args, {
    cwd: fixture,
    env,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  const log = join(bundle, `${name}.log`);
  writeFileSync(log, `${result.stdout ?? ''}${result.stderr ?? ''}`);
  report.checks.push({
    name,
    file,
    args,
    status: result.status,
    error: result.error?.message,
    logSha256: sha(readFileSync(log)),
  });
  if (result.error || result.status !== 0)
    throw new Error(`${name} failed; see ${log}`);
}
function patch(before, after, destination) {
  const output = run(
    'git',
    [
      'diff',
      '--no-index',
      '--binary',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      before,
      after,
    ],
    bundle,
    [0, 1],
  );
  const text = output
    .replaceAll(`a/${before}/`, 'a/')
    .replaceAll(`b/${after}/`, 'b/')
    .replaceAll(`a/${after}/`, 'a/')
    .replaceAll(`b/${before}/`, 'b/');
  writeFileSync(join(bundle, destination), text);
  return sha(text);
}
function dependencies(lock) {
  return lock
    .split('[[package]]')
    .slice(1)
    .map((block) =>
      [...block.matchAll(/^(name|version|source|checksum) = "([^"]+)"$/gm)].map(
        (m) => [m[1], m[2]],
      ),
    )
    .filter((fields) => fields.some(([key]) => key === 'source'))
    .map((fields) => JSON.stringify(fields));
}
try {
  if (
    git(producer, [
      'rev-parse',
      `${producerRevision}:tools/native/consent-broker`,
    ]).trim() !== brokerTree
  )
    throw new Error('Producer broker tree mismatch');
  for (const [repo, revision, output, paths] of [
    [root, consumerBase, 'consumer.tar', []],
    [
      producer,
      producerRevision,
      'producer.tar',
      ['tools/native/consent-broker'],
    ],
  ]) {
    const archive = join(scratch, output);
    const entries = git(repo, ['ls-tree', '-r', revision, '--', ...paths]);
    if (
      entries
        .trim()
        .split('\n')
        .some((entry) => !/^100(?:644|755) blob /.test(entry))
    )
      throw new Error('Non-regular archive entry refused');
    git(repo, [
      'archive',
      '--format=tar',
      `--output=${archive}`,
      revision,
      ...paths,
    ]);
    report[`${output}Sha256`] = sha(readFileSync(archive));
    run('tar', ['-xf', archive, '-C', fixture]);
  }
  const files = [
    ...new Set(
      git(root, [
        'ls-files',
        '--cached',
        '--others',
        '--exclude-standard',
        '-z',
      ]).split('\0'),
    ),
  ].filter(
    (file) =>
      file.startsWith('apps/stellar-desktop/src-tauri/') ||
      file.startsWith('tools/native/consent-ui/'),
  );
  for (const file of files) {
    const beforePath = join(fixture, file);
    let before = null;
    try {
      before = normalized(readFileSync(beforePath), file);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const afterRaw = readFileSync(join(root, file)),
      after = normalized(afterRaw, file);
    report.consumerFiles[file] = {
      beforeSha256: before && sha(before),
      afterSha256: sha(after),
      rawWorkingSha256: sha(afterRaw),
    };
    if (before) {
      put(join(bundle, 'before', file), before);
      put(beforePath, before);
    }
    put(join(bundle, 'after', file), after);
  }
  report.consumerPatchSha256 = patch('before', 'after', 'consumer.patch');
  // Only this new disposable fixture receives the producer root preimage and
  // proposed root-side edits. Neither owning worktree's root files are writable here.
  const producerRoot = git(producer, [
    'show',
    `${producerRevision}:Cargo.toml`,
  ]);
  const producerLock = git(producer, [
    'show',
    `${producerRevision}:Cargo.lock`,
  ]);
  const expected = '"tools/native/consent-broker"]';
  if (!producerRoot.includes(expected))
    throw new Error('Unexpected root member preimage');
  const pairedRoot = producerRoot.replace(
    expected,
    '"tools/native/consent-broker", "tools/native/consent-ui"]',
  );
  put(join(fixture, 'Cargo.toml'), producerRoot);
  put(join(fixture, 'Cargo.lock'), producerLock);
  run('git', [
    '-c',
    'core.autocrlf=false',
    'apply',
    '--check',
    join(bundle, 'consumer.patch'),
  ]);
  run('git', [
    '-c',
    'core.autocrlf=false',
    'apply',
    join(bundle, 'consumer.patch'),
  ]);
  put(join(fixture, 'Cargo.toml'), pairedRoot);
  report.consumerPatchAppliedInFixture = true;
  const host = /^host: (.+)$/m.exec(run('rustc', ['-vV']))?.[1].trim();
  if (!host) throw new Error('Missing native compiler host');
  report.host = host;
  run('cargo', [
    'metadata',
    '--offline',
    '--format-version=1',
    '--filter-platform',
    host,
  ]);
  const pairedLock = readFileSync(join(fixture, 'Cargo.lock'));
  const original = dependencies(producerLock);
  if (
    dependencies(pairedLock.toString()).some(
      (entry) => !original.includes(entry),
    )
  )
    throw new Error('External dependency drift from producer lock');
  for (const [file, before, after] of [
    ['Cargo.toml', producerRoot, pairedRoot],
    ['Cargo.lock', producerLock, pairedLock],
  ]) {
    put(join(bundle, 'root-before', file), before);
    put(join(bundle, 'root-after', file), after);
    report.rootFiles[file] = {
      owner: '339',
      beforeSha256: sha(before),
      afterSha256: sha(after),
    };
  }
  report.rootPatchSha256 = patch(
    'root-before',
    'root-after',
    'producer-root.patch',
  );
  const rootCheck = join(scratch, 'root-check');
  put(join(rootCheck, 'Cargo.toml'), producerRoot);
  put(join(rootCheck, 'Cargo.lock'), producerLock);
  run(
    'git',
    [
      '-c',
      'core.autocrlf=false',
      'apply',
      '--check',
      join(bundle, 'producer-root.patch'),
    ],
    rootCheck,
  );
  run(
    'git',
    ['-c', 'core.autocrlf=false', 'apply', join(bundle, 'producer-root.patch')],
    rootCheck,
  );
  for (const [file, entry] of Object.entries(report.rootFiles)) {
    if (sha(readFileSync(join(rootCheck, file))) !== entry.afterSha256)
      throw new Error('Paired root patch did not produce exact postimage');
  }
  report.rootPatchApplicabilityChecked = true;
  report.rootPatchAppliedAndHashVerified = true;
  report.cachedRenderer = {};
  rendererSnapshot(
    join(root, 'dist/apps/stellar-desktop/browser'),
    join(fixture, 'dist/apps/stellar-desktop/browser'),
  );
  // The unchanged AST size gate enumerates Git sources. Give only this fresh
  // fixture an index, and verify its Rust inventory against the immutable trees
  // plus explicit consumer postimages; no owning index or branch is touched.
  const rustPaths = [
    ...new Set(
      [
        ...git(root, ['ls-tree', '-r', '--name-only', consumerBase])
          .trim()
          .split('\n'),
        ...git(producer, [
          'ls-tree',
          '-r',
          '--name-only',
          producerRevision,
          '--',
          'tools/native/consent-broker',
        ])
          .trim()
          .split('\n'),
        ...Object.keys(report.consumerFiles),
      ].filter((file) => file.endsWith('.rs')),
    ),
  ].sort();
  run('git', ['init', '--quiet']);
  const inventory = join(scratch, 'rust-paths');
  writeFileSync(inventory, rustPaths.join('\0') + '\0');
  run('git', [
    '-c',
    'core.autocrlf=false',
    'add',
    '--force',
    `--pathspec-from-file=${inventory}`,
    '--pathspec-file-nul',
  ]);
  const actual = run('git', [
    'ls-files',
    '-z',
    '--cached',
    '--others',
    '--exclude-standard',
    '--',
    '*.rs',
  ])
    .split('\0')
    .filter(Boolean)
    .sort();
  if (JSON.stringify(actual) !== JSON.stringify(rustPaths))
    throw new Error('Fixture Rust inventory mismatch');
  report.rustSourceCount = rustPaths.length;
  report.rustInventorySha256 = sha(rustPaths.join('\0'));
  for (const [file, entry] of Object.entries(report.consumerFiles)) {
    if (
      sha(normalized(readFileSync(join(fixture, file)), file)) !==
      entry.afterSha256
    )
      throw new Error(`Fixture consumer postimage mismatch: ${file}`);
  }
  recordCheck('fmt', 'cargo', ['fmt', '--all', '--', '--check']);
  recordCheck('clippy', 'cargo', [
    'clippy',
    '--offline',
    '--locked',
    '--workspace',
    '--all-targets',
    '--',
    '-D',
    'warnings',
  ]);
  recordCheck('smoke-clippy', 'cargo', [
    'clippy',
    '--offline',
    '--locked',
    '-p',
    'stellar-desktop',
    '--all-targets',
    '--features',
    'native-smoke',
    '--',
    '-D',
    'warnings',
  ]);
  recordCheck('tests', 'cargo', [
    'test',
    '--offline',
    '--locked',
    '--workspace',
  ]);
  recordCheck('build', 'cargo', [
    'build',
    '--offline',
    '--locked',
    '-p',
    'stellar-desktop',
  ]);
  recordCheck('size', 'cargo', [
    'run',
    '--offline',
    '--locked',
    '--quiet',
    '-p',
    'stellar-rust-size',
    '--',
    fixture,
  ]);
  report.externalBindingInputs = Object.fromEntries(
    [
      'tools/native/contracts.mjs',
      'libs/desktop-contracts/src/generated.ts',
      'libs/desktop-contracts/src/lib/capability-label.ts',
      'node_modules/typescript/package.json',
      'node_modules/typescript/lib/typescript.js',
    ].map((file) => [file, sha(readFileSync(join(root, file)))]),
  );
  report.generatedBindings = [];
  const { verifyBindings } = await import(
    pathToFileURL(join(root, 'tools/native/contracts.mjs'))
  );
  verifyBindings((variant) => {
    const result = run('cargo', [
      'run',
      '--offline',
      '--locked',
      '--quiet',
      '-p',
      'stellar-desktop',
      '--bin',
      'export-contracts',
      ...(variant ? ['--features', 'contract-variant-fixture'] : []),
    ]);
    report.generatedBindings.push({ variant, sha256: sha(result) });
    return result;
  });
  for (const [file, hash] of Object.entries(report.externalBindingInputs)) {
    if (sha(readFileSync(join(root, file))) !== hash)
      throw new Error('Binding verifier/input changed');
  }
  report.bindingsAndExhaustiveConsumer = true;
  for (const [file, entry] of Object.entries(report.consumerFiles)) {
    if (sha(readFileSync(join(root, file))) !== entry.rawWorkingSha256)
      throw new Error('Consumer changed during fixture verification');
  }
  for (const [file, hash] of Object.entries(ownRoot)) {
    if (sha(readFileSync(join(root, file))) !== hash)
      throw new Error('Owning root changed during fixture verification');
  }
  report.ownRootUnchanged = ownRoot;
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = error.message;
  process.exitCode = 1;
} finally {
  report.ownRootAfter = Object.fromEntries(
    Object.keys(ownRoot).map((file) => [
      file,
      sha(readFileSync(join(root, file))),
    ]),
  );
  writeFileSync(
    join(bundle, 'applicability.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(
    JSON.stringify({ bundle, passed: report.passed, failure: report.failure }),
  );
}
