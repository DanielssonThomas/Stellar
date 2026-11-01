import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { requiresBrowserInstall, requireSuccessfulJobs } from './ci.mjs';

test('installs browsers for every affected project that exposes an E2E target', () => {
  assert.equal(requiresBrowserInstall('[]'), false);
  for (const projects of [
    ['stellar-web-e2e'],
    ['stellar-desktop-e2e'],
    ['future-application-tests'],
    ['stellar-web-e2e', 'stellar-desktop-e2e'],
  ]) {
    assert.equal(requiresBrowserInstall(JSON.stringify(projects)), true);
  }
});

test('invalid Nx output fails instead of skipping browser dependencies', () => {
  for (const value of ['', 'null', '{}', '[1]', '[""]', 'warning\n[]']) {
    assert.throws(() => requiresBrowserInstall(value));
  }
});

test('required verify rejects failure, cancellation, skipping and missing results', () => {
  assert.doesNotThrow(() => requireSuccessfulJobs('success', 'success'));
  for (const status of ['failure', 'cancelled', 'skipped', '', undefined]) {
    assert.throws(() => requireSuccessfulJobs('success', status));
    assert.throws(() => requireSuccessfulJobs(status, 'success'));
  }
});

test('the command exits nonzero for a failed Windows job and malformed project output', () => {
  const script = fileURLToPath(new URL('./ci.mjs', import.meta.url));
  const failed = spawnSync(process.execPath, [script, 'gate'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      QUALITY_RESULT: 'success',
      NATIVE_RESULT: 'failure',
    },
    windowsHide: true,
  });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /native=failure/);
  const malformed = spawnSync(process.execPath, [script, 'e2e'], {
    input: 'not a project list',
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(malformed.status, 1);
});
