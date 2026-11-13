// Disconnected exact captured producer -> consumer bridge -> native snapshot evidence.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const retained = JSON.parse(readFileSync(resolve(process.argv[2]), 'utf8'));
if (
  !retained.fixtureOnly ||
  retained.liveOperation !== false ||
  !retained.passed
)
  throw Error('Expected retained disconnected native composition report');
const fixture = retained.fixture;
if (
  retained.pairedManifestSha256 !==
  '48e509f1fe527d5f40ea59942116a1ee4af8017bfef0f3bc141d674ff882ce9f'
)
  throw Error('Expected the reviewed immutable root/consumer pair');
for (const [file, expected] of Object.entries({
  'Cargo.toml':
    '576254955a483eae982f01ce7a620969dc683ffbc8711f7a4b5775260b1d9de7',
  'Cargo.lock':
    '1d273fb39e1995ec3419dbd2f86ffbc4fe1e74d8e47297c1c5f7bed0916e06a9',
})) {
  if (
    createHash('sha256')
      .update(
        readFileSync(join(fixture, file), 'utf8').replaceAll('\r\n', '\n'),
      )
      .digest('hex') !== expected
  )
    throw Error('Retained root postimage mismatch: ' + file);
}
const bundle = join(
  root,
  'artifacts/issue-299',
  `plugin-consumer-${Date.now()}`,
);
mkdirSync(bundle, { recursive: true });
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const roots = Object.fromEntries(
  ['Cargo.toml', 'Cargo.lock'].map((f) => [
    f,
    sha(readFileSync(join(root, f))),
  ]),
);
const fixtureRoots = Object.fromEntries(
  ['Cargo.toml', 'Cargo.lock'].map((f) => [
    f,
    sha(readFileSync(join(fixture, f))),
  ]),
);
const env = {
  ...process.env,
  CARGO_TARGET_DIR: join(root, 'target'),
  STELLAR_PLUGIN_FRAME_FIXTURE: join(bundle, 'projected-frames.json'),
  STELLAR_PLUGIN_SNAPSHOT_FIXTURE: join(bundle, 'native-snapshot.json'),
};
const report = {
  fixtureOnly: true,
  liveOperation: false,
  retainedReport: resolve(process.argv[2]),
  fixture,
  bundle,
  roots,
  fixtureRoots,
  source: {},
  checks: [],
};
function run(name, command, args, cwd = fixture) {
  const r = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 600000,
  });
  const log = (r.stdout ?? '') + (r.stderr ?? '');
  writeFileSync(join(bundle, name + '.log'), log);
  report.checks.push({
    name,
    command,
    args,
    status: r.status,
    sha256: sha(log),
  });
  if (r.status !== 0 || r.error)
    throw r.error ?? Error(name + ' failed: ' + bundle);
  return r.stdout;
}
let failure;
try {
  const files = run(
    'inventory',
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard'],
    root,
  )
    .trim()
    .split('\n');
  for (const file of files) {
    if (
      !file.startsWith('apps/stellar-desktop/src-tauri/') &&
      !file.startsWith('tools/native/evidence/')
    )
      continue;
    const bytes = readFileSync(join(root, file));
    report.source[file] = sha(bytes);
    mkdirSync(dirname(join(fixture, file)), { recursive: true });
    cpSync(join(root, file), join(fixture, file));
  }
  const python = process.env['STELLAR_TEST_PYTHON'];
  if (!python)
    throw Error('Set STELLAR_TEST_PYTHON to the existing test interpreter');
  run(
    'projection',
    python,
    [
      'tools/native/fixtures/plugin_notification_projection.py',
      'tools/native/evidence/stellar-herdr-notification-forward-v1.json',
      env.STELLAR_PLUGIN_FRAME_FIXTURE,
    ],
    root,
  );
  run(
    'python',
    python,
    [
      '-m',
      'unittest',
      'discover',
      '-s',
      'tools/native',
      '-p',
      'ivy*test.py',
      '-q',
    ],
    root,
  );
  run('format', 'cargo', ['fmt', '--all', '--', '--check']);
  run('tests', 'cargo', ['test', '--offline', '--locked', '--workspace']);
  run('clippy', 'cargo', [
    'clippy',
    '--offline',
    '--locked',
    '--workspace',
    '--all-targets',
    '--',
    '-D',
    'warnings',
  ]);
  run('smoke-clippy', 'cargo', [
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
  run('build', 'cargo', [
    'build',
    '--offline',
    '--locked',
    '-p',
    'stellar-desktop',
    '--features',
    'custom-protocol',
  ]);
  run('size', 'cargo', [
    'run',
    '--offline',
    '--locked',
    '--quiet',
    '-p',
    'stellar-rust-size',
    '--',
    root,
  ]);
  for (const [f, digest] of Object.entries(report.source))
    if (sha(readFileSync(join(root, f))) !== digest)
      throw Error('Source changed during verification: ' + f);
  report.framesSha256 = sha(readFileSync(env.STELLAR_PLUGIN_FRAME_FIXTURE));
  report.snapshotSha256 = sha(
    readFileSync(env.STELLAR_PLUGIN_SNAPSHOT_FIXTURE),
  );
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = String(error);
  failure = error;
} finally {
  for (const f of Object.keys(roots))
    if (
      sha(readFileSync(join(root, f))) !== roots[f] ||
      sha(readFileSync(join(fixture, f))) !== fixtureRoots[f]
    ) {
      report.passed = false;
      failure = Error('Root manifest changed');
    }
  writeFileSync(
    join(bundle, 'report.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(
    JSON.stringify({ bundle, passed: report.passed, failure: report.failure }),
  );
}
if (failure) throw failure;
