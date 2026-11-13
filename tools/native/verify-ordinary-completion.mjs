// Disconnected bridge -> native receipt/update snapshot. Never connects to Hermes.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const manifestPath = resolve(process.argv[2]);
const manifestSha256 = createHash('sha256')
  .update(readFileSync(manifestPath))
  .digest('hex');
if (
  manifestSha256 !==
  '48e509f1fe527d5f40ea59942116a1ee4af8017bfef0f3bc141d674ff882ce9f'
)
  throw Error('Expected the immutable e216f69 paired-fixture manifest');
const paired = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (!paired.passed || paired.productionEnabled !== false)
  throw Error('A retained disconnected paired fixture is required');
const scratch = mkdtempSync(join(tmpdir(), 'stellar299-ordinary-'));
const fixture = join(scratch, 'integration');
const bundle = join(root, 'artifacts/issue-299', `ordinary-${Date.now()}`);
mkdirSync(bundle, { recursive: true });
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const canonical = (file) =>
  Buffer.from(readFileSync(file, 'utf8').replaceAll('\r\n', '\n'));
const ownedRoots = Object.fromEntries(
  ['Cargo.toml', 'Cargo.lock'].map((p) => [
    p,
    sha(readFileSync(join(root, p))),
  ]),
);
const report = {
  fixtureOnly: true,
  liveOperation: false,
  base: 'e216f69d5c5dd2c70276115abea25db1dd1a94e6',
  pairedManifestSha256: manifestSha256,
  scratch,
  fixture,
  source: {},
  checks: [],
};
const env = {
  ...process.env,
  CARGO_TARGET_DIR: join(root, 'target'),
  STELLAR_ORDINARY_EVENT_FIXTURE: join(scratch, 'event.json'),
  STELLAR_ORDINARY_SNAPSHOT_FIXTURE: join(scratch, 'snapshot.json'),
};
function run(name, executable, args, cwd = fixture) {
  const result = spawnSync(executable, args, {
    cwd,
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 300_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  writeFileSync(join(bundle, `${name}.log`), output);
  report.checks.push({
    name,
    args,
    status: result.status,
    sha256: sha(output),
  });
  if (result.error || result.status !== 0)
    throw result.error ?? Error(`${name} failed; see ${bundle}`);
  return result.stdout;
}
let failure;
try {
  for (const [name, revision, paths] of [
    ['consumer', report.base, []],
    ['broker', paired.producerRevision, ['tools/native/consent-broker']],
  ]) {
    const result = spawnSync(
      'git',
      ['archive', '--format=tar', revision, ...paths],
      {
        cwd: root,
        windowsHide: true,
        maxBuffer: 128 * 1024 * 1024,
      },
    );
    if (result.status !== 0) throw Error(`Immutable ${name} export failed`);
    report[`${name}ArchiveSha256`] = sha(result.stdout);
    const archive = join(scratch, `${name}.tar`);
    writeFileSync(archive, result.stdout);
    mkdirSync(fixture, { recursive: true });
    run(`extract-${name}`, 'tar', ['-xf', archive, '-C', fixture], root);
  }
  const tree = spawnSync(
    'git',
    ['rev-parse', `${paired.producerRevision}:tools/native/consent-broker`],
    {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  if (tree.status !== 0 || tree.stdout.trim() !== paired.brokerTree)
    throw Error('Producer broker tree mismatch');
  report.brokerTree = tree.stdout.trim();
  for (const [file, hashes] of Object.entries(paired.rootFiles))
    if (sha(canonical(join(paired.fixture, file))) !== hashes.afterSha256)
      throw Error(`Retained root mismatch: ${file}`);
  for (const [file, hashes] of Object.entries(paired.consumerFiles)) {
    const bytes = readFileSync(join(fixture, file));
    const digest = sha(bytes);
    if (
      digest !== hashes.afterSha256 &&
      digest !== hashes.rawWorkingSha256 &&
      sha(Buffer.from(bytes.toString().replaceAll('\r\n', '\n'))) !==
        hashes.afterSha256
    )
      throw Error(`Immutable consumer mismatch: ${file}`);
  }
  for (const file of Object.keys(paired.rootFiles))
    cpSync(join(paired.fixture, file), join(fixture, file));
  for (const [file, digest] of Object.entries(paired.cachedRenderer)) {
    const source = join(
      paired.fixture,
      'dist/apps/stellar-desktop/browser',
      file,
    );
    if (sha(readFileSync(source)) !== digest)
      throw Error(`Cached renderer mismatch: ${file}`);
    const destination = join(
      fixture,
      'dist/apps/stellar-desktop/browser',
      file,
    );
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination);
  }
  const overlay = [
    'apps/stellar-desktop/src-tauri/src/ivy/ivy_bridge.py',
    'apps/stellar-desktop/src-tauri/src/ivy/background_updates.rs',
    'apps/stellar-desktop/src-tauri/src/ivy/mod.rs',
    'apps/stellar-desktop/src-tauri/src/ivy/ordinary_completion_tests.rs',
  ];
  for (const file of overlay) {
    const bytes = readFileSync(join(root, file));
    writeFileSync(join(fixture, file), bytes);
    report.source[file] = sha(bytes);
  }
  for (const file of [
    'tools/native/verify-ordinary-completion.mjs',
    'tools/native/ivy_ordinary_completion_test.py',
    'tools/native/ivy_bridge_test.py',
    ...[
      'activity',
      'controls',
      'lifecycle',
      'edit_policy',
      'conversation',
      'voice_expression',
    ].map((name) => `apps/stellar-desktop/src-tauri/src/ivy/ivy_${name}.py`),
    'apps/stellar-desktop-e2e/src/background-updates.spec.ts',
  ])
    report.source[file] = sha(readFileSync(join(root, file)));
  const event = run(
    'bridge-projection',
    env.STELLAR_TEST_PYTHON ?? 'python',
    ['-B', '-m', 'tools.native.ivy_ordinary_completion_test', '--emit'],
    root,
  );
  const parsed = JSON.parse(event);
  if (parsed.data.params.payload.autonomous !== true)
    throw Error(
      'Ordinary bridge projection did not produce a receipt candidate',
    );
  writeFileSync(env.STELLAR_ORDINARY_EVENT_FIXTURE, event);
  run('fmt', 'cargo', ['fmt', '--all', '--', '--check']);
  run('ordinary-native', 'cargo', [
    'test',
    '--offline',
    '--locked',
    '-p',
    'stellar-desktop',
    'ordinary_completion_',
    '--',
    '--test-threads=1',
  ]);
  const snapshot = JSON.parse(
    readFileSync(env.STELLAR_ORDINARY_SNAPSHOT_FIXTURE, 'utf8'),
  );
  if (
    snapshot.fixtureOnly !== true ||
    snapshot.visible.background_updates.length !== 1 ||
    snapshot.claimed.background_updates[0].speech_claim === null
  )
    throw Error('Incomplete native snapshot/claim evidence');
  for (const file of ['event.json', 'snapshot.json'])
    cpSync(join(scratch, file), join(bundle, basename(file)));
  report.snapshot = env.STELLAR_ORDINARY_SNAPSHOT_FIXTURE;
  report.passed = true;
} catch (error) {
  failure = error;
} finally {
  report.ownRootsUnchanged = Object.entries(ownedRoots).every(
    ([p, hash]) => sha(readFileSync(join(root, p))) === hash,
  );
  report.sourceUnchanged = Object.entries(report.source).every(
    ([p, hash]) => sha(readFileSync(join(root, p))) === hash,
  );
  report.passed =
    report.passed === true &&
    report.ownRootsUnchanged &&
    report.sourceUnchanged;
  writeFileSync(join(bundle, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ bundle, ...report }));
}
if (failure) throw failure;
if (!report.ownRootsUnchanged) throw Error('Owning root changed');
if (!report.sourceUnchanged) throw Error('Verified consumer inputs changed');
