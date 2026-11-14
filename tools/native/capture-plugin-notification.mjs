// Execute only the canonical candidate fixture in a fresh source copy, never a gateway.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const candidate = resolve(process.argv[2]);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(
  readFileSync(join(candidate, 'source-manifest.json'), 'utf8'),
);
if (manifest.base_commit !== '3b421578588243f920886e6fe79a6faa87ea026e')
  throw Error('Unexpected runtime base revision');
if (
  sha(readFileSync(join(candidate, 'source-manifest.json'))) !==
    '69137f2a2e795e0bf75be651db72aff278f9de3b5ad7ea9958469a86612ed546' ||
  sha(readFileSync(join(candidate, 'consumer-contract.json'))) !==
    '07973c54686f4ad83e3097385aaff75738746743adeb08fee18d94b31e045150'
)
  throw Error('Runtime source/consumer contract manifest mismatch');
const patch = join(candidate, 'plugin-notification-candidate.patch');
if (
  sha(readFileSync(patch)) !==
  'c0a21ab5118d6f7ab23b617e7ea2d2f81d072fa1d9fcd63ba0ba857d8d7356ce'
)
  throw Error('Runtime candidate patch mismatch');
const scratch = mkdtempSync(join(tmpdir(), 'stellar299-plugin-'));
const source = join(scratch, 'source');
const bundle = join(
  root,
  'artifacts/issue-299',
  `plugin-canonical-${Date.now()}`,
);
mkdirSync(source);
mkdirSync(bundle, { recursive: true });
const env = {
  ...process.env,
  HERMES_PYTHON: join(candidate, 'test-env/Scripts/python.exe'),
  HERMES_HOME: join(scratch, 'test-home'),
  PYTHONDONTWRITEBYTECODE: '1',
};
delete env.MSYS_NO_PATHCONV;
delete env.MSYS2_ARG_CONV_EXCL;
const report = {
  fixtureOnly: true,
  installed: false,
  source,
  scratch,
  base: manifest.base_commit,
  patchSha256: sha(readFileSync(patch)),
  toolSha256: sha(readFileSync(import.meta.filename)),
  fixtureSha256: sha(
    readFileSync(
      join(root, 'tools/native/fixtures/plugin_notification_capture.py'),
    ),
  ),
  passed: false,
  checks: [],
};
const fixtureBytes = readFileSync(
  join(root, 'tools/native/fixtures/plugin_notification_capture.py'),
);
report.fixtureSha256 = sha(fixtureBytes);
function run(name, file, args, cwd = source) {
  const r = spawnSync(file, args, {
    cwd,
    env,
    windowsHide: true,
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 128 * 1024 * 1024,
  });
  writeFileSync(
    join(bundle, name + '.log'),
    (r.stdout ?? '') + (r.stderr ?? ''),
  );
  report.checks.push({ name, file, args, status: r.status });
  if (r.error || r.status !== 0)
    throw r.error ?? Error(`${name} failed; see ${bundle}`);
  return r.stdout;
}
try {
  const archive = join(scratch, 'base.tar');
  run(
    'base',
    'git',
    [
      '-C',
      'D:/Hermes/hermes-agent',
      'archive',
      '--format=tar',
      `--output=${archive}`,
      manifest.base_commit,
    ],
    root,
  );
  const archiveHash = createHash('sha256');
  for await (const chunk of createReadStream(archive))
    archiveHash.update(chunk);
  report.baseArchiveSha256 = archiveHash.digest('hex');
  run('extract', 'tar', ['-xf', archive, '-C', source]);
  for (const row of manifest.files) {
    let original = null;
    try {
      original = readFileSync(join(source, row.path));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    if (
      row.new
        ? original !== null
        : original === null || sha(original) !== row.original_sha256
    )
      throw Error(`Candidate preimage mismatch: ${row.path}`);
  }
  run('apply-check', 'git', [
    '-c',
    'core.autocrlf=false',
    'apply',
    '--check',
    patch,
  ]);
  run('apply', 'git', ['-c', 'core.autocrlf=false', 'apply', patch]);
  for (const row of manifest.files)
    if (sha(readFileSync(join(source, row.path))) !== row.candidate_sha256)
      throw Error(`Candidate postimage mismatch: ${row.path}`);
  report.consumerFixtureSha256 = sha(fixtureBytes);
  writeFileSync(
    join(source, 'tests/gateway/test_stellar299_capture.py'),
    fixtureBytes,
  );
  run('canonical-capture', 'C:/Program Files/Git/bin/bash.exe', [
    'scripts/run_tests.sh',
    'tests/gateway/test_stellar299_capture.py',
    '--file-retries',
    '0',
    '-j',
    '1',
    '-s',
    '-v',
    '--tb=short',
  ]);
  const frames = readFileSync(join(source, 'consumer-canonical-frames.json'));
  const value = JSON.parse(frames);
  if (
    value.fixture_only !== true ||
    !value.terminal.delivery_allowed ||
    value.denied.delivery_allowed
  )
    throw Error('Incomplete canonical result/revoke evidence');
  writeFileSync(join(bundle, 'frames.json'), frames);
  report.framesSha256 = sha(frames);
  report.passed = true;
} finally {
  report.sourceUnchanged =
    report.checks.some((v) => v.name === 'apply' && v.status === 0) &&
    manifest.files.every(
      (v) => sha(readFileSync(join(source, v.path))) === v.candidate_sha256,
    );
  report.inputsUnchanged =
    report.toolSha256 === sha(readFileSync(import.meta.filename)) &&
    report.fixtureSha256 ===
      sha(
        readFileSync(
          join(root, 'tools/native/fixtures/plugin_notification_capture.py'),
        ),
      );
  report.passed =
    report.passed && report.sourceUnchanged && report.inputsUnchanged;
  writeFileSync(join(bundle, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ bundle, ...report }));
}
if (!report.passed) throw Error(`Capture verification failed; see ${bundle}`);
