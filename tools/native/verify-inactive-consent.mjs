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
import { join, resolve, relative } from 'node:path';

// Disposable compatibility verification only. Never builds/runs Desktop or an OS verifier.
const revision = 'a6864dfc306518c0f945c194b9c069357585a9c2';
const expectedTree = 'bdadecbb921df6fee570235b0cd896ffcc33aa50';
const root = resolve(import.meta.dirname, '../..');
const producer = resolve(process.argv[2] ?? '../stellar-issue-339');
const scratch = mkdtempSync(join(tmpdir(), 'stellar299-inactive-consent-'));
const reportPath = join(
  root,
  'artifacts/issue-299',
  `inactive-client-${Date.now()}.json`,
);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const report = {
  revision,
  expectedTree,
  scratch,
  consumer: {},
  checks: [],
  operational: false,
  verifierSha256: sha(readFileSync(import.meta.filename)),
};

function command(file, args, cwd = scratch) {
  const result = spawnSync(file, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${file} failed: ${result.error?.message ?? result.stderr}`,
    );
  return result.stdout;
}
function git(args) {
  return command('git', [
    '-c',
    `safe.directory=${producer}`,
    '-C',
    producer,
    ...args,
  ]);
}
function copyTree(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const item of readdirSync(source, { withFileTypes: true })) {
    if (item.name === 'target' || item.name === 'Cargo.lock') continue;
    const from = join(source, item.name),
      to = join(destination, item.name);
    if (item.isDirectory()) copyTree(from, to);
    else if (item.isFile()) {
      const bytes = readFileSync(from);
      report.consumer[relative(root, from).replaceAll('\\', '/')] = sha(bytes);
      writeFileSync(to, bytes);
    } else throw new Error('Non-regular consumer input refused');
  }
}
function check(name, args) {
  const result = spawnSync('cargo', args, {
    cwd: scratch,
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      CARGO_TARGET_DIR: join(root, 'target/inactive-consent'),
    },
  });
  const log = join(scratch, `${name}.log`);
  writeFileSync(log, `${result.stdout ?? ''}${result.stderr ?? ''}`);
  report.checks.push({
    name,
    args,
    status: result.status,
    error: result.error?.message,
    log,
  });
  if (result.error || result.status !== 0)
    throw new Error(`${name} failed; see ${log}`);
}
function packages(lock) {
  return lock
    .split('[[package]]')
    .slice(1)
    .map((block) => {
      const fields = Object.fromEntries(
        [
          ...block.matchAll(/^(name|version|source|checksum) = "([^"]+)"$/gm),
        ].map((match) => [match[1], match[2]]),
      );
      return fields;
    })
    .filter((item) => item.source);
}
try {
  const tree = git([
    'rev-parse',
    `${revision}:tools/native/consent-broker`,
  ]).trim();
  if (tree !== expectedTree) throw new Error('Producer tree mismatch');
  const entries = git([
    'ls-tree',
    '-r',
    revision,
    '--',
    'tools/native/consent-broker',
  ]);
  if (
    entries
      .trim()
      .split('\n')
      .some((entry) => !/^100(?:644|755) blob /.test(entry))
  )
    throw new Error('Non-regular producer archive entry refused');
  const archive = join(scratch, 'producer.tar');
  git([
    'archive',
    '--format=tar',
    `--output=${archive}`,
    revision,
    'tools/native/consent-broker',
  ]);
  report.archiveSha256 = sha(readFileSync(archive));
  mkdirSync(join(scratch, 'producer'));
  command('tar', ['-xf', archive, '-C', join(scratch, 'producer')]);
  copyTree(join(root, 'tools/native/consent-ui'), join(scratch, 'ui'));
  // Consumer UI is a standalone unregistered crate in299; only the disposable
  // harness joins it to this exact producer crate. Shared Cargo files stay untouched.
  const manifest = join(scratch, 'ui/Cargo.toml');
  writeFileSync(
    manifest,
    readFileSync(manifest, 'utf8').replace('[workspace]', ''),
  );
  report.uiHarnessManifestSha256 = sha(readFileSync(manifest));
  mkdirSync(join(scratch, 'consumer/src'), { recursive: true });
  for (const file of [
    'native_consent_client.rs',
    'native_consent_write.rs',
    'native_consent_client_tests.rs',
    'native_consent_fixtures_tests.rs',
    'native_consent_write_tests.rs',
  ]) {
    const from = join(root, 'apps/stellar-desktop/src-tauri/src/ivy', file);
    const bytes = readFileSync(from);
    report.consumer[relative(root, from).replaceAll('\\', '/')] = sha(bytes);
    writeFileSync(join(scratch, 'consumer/src', file), bytes);
  }
  writeFileSync(
    join(scratch, 'consumer/src/lib.rs'),
    '#![forbid(unsafe_code)]\npub mod native_consent_client;\n',
  );
  writeFileSync(
    join(scratch, 'consumer/Cargo.toml'),
    `[package]
name = "stellar-inactive-consumer"
version = "0.1.0"
edition = "2024"
publish = false
[dependencies]
stellar-consent-broker = { path = "../producer/tools/native/consent-broker" }
stellar-consent-ui = { path = "../ui" }
`,
  );
  writeFileSync(
    join(scratch, 'Cargo.toml'),
    '[workspace]\nmembers = ["producer/tools/native/consent-broker", "consumer", "ui"]\nresolver = "3"\n',
  );
  const lock = git(['show', `${revision}:Cargo.lock`]);
  const toolchain = git(['show', `${revision}:rust-toolchain.toml`]);
  writeFileSync(join(scratch, 'rust-toolchain.toml'), toolchain);
  report.toolchainSha256 = sha(toolchain);
  writeFileSync(join(scratch, 'Cargo.lock'), lock);
  command('cargo', ['metadata', '--offline', '--format-version=1']);
  const original = packages(lock).map((item) => JSON.stringify(item));
  for (const dependency of packages(
    readFileSync(join(scratch, 'Cargo.lock'), 'utf8'),
  )) {
    if (!original.includes(JSON.stringify(dependency)))
      throw new Error('Dependency drift from producer lock');
  }
  report.lockSha256 = sha(readFileSync(join(scratch, 'Cargo.lock')));
  check('fmt', ['fmt', '--all', '--', '--check']);
  check('clippy', [
    'clippy',
    '--offline',
    '--locked',
    '--workspace',
    '--all-targets',
    '--',
    '-D',
    'warnings',
  ]);
  check('tests', ['test', '--offline', '--locked', '--workspace']);
  for (const [file, hash] of Object.entries(report.consumer)) {
    if (sha(readFileSync(join(root, file))) !== hash)
      throw new Error('Consumer changed during verification');
  }
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
    }),
  );
}
