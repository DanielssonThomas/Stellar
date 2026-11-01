import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const project = JSON.parse(
  readFileSync(
    new URL('../../apps/stellar-desktop/project.json', import.meta.url),
  ),
);
const config = JSON.parse(
  readFileSync(
    new URL(
      '../../apps/stellar-desktop/src-tauri/tauri.conf.json',
      import.meta.url,
    ),
  ),
);
const capability = JSON.parse(
  readFileSync(
    new URL(
      '../../apps/stellar-desktop/src-tauri/capabilities/main.json',
      import.meta.url,
    ),
  ),
);

function assertCacheInputs(candidate) {
  for (const path of [
    'Cargo.toml',
    'Cargo.lock',
    'rust-toolchain.toml',
    'tools/native/**/*',
    'libs/desktop-contracts/src/**/*',
    'docs/architecture/rust-tauri.md',
  ])
    assert.ok(
      candidate.namedInputs.native.includes(`{workspaceRoot}/${path}`),
      `Missing native input: ${path}`,
    );
  assert.ok(
    candidate.namedInputs.native.includes('{projectRoot}/src-tauri/**/*'),
  );
  for (const target of [
    'native-fmt',
    'native-clippy',
    'native-test',
    'contract-check',
    'native-build',
    'native-smoke',
    'rust-size-check',
  ])
    assert.ok(
      candidate.targets[target].inputs.includes('native'),
      `${target} omits native inputs`,
    );
  assert.equal(candidate.targets['native-smoke'].cache, false);
  assert.equal(candidate.targets['native-launch'].cache, false);
  assert.deepEqual(candidate.targets['native-smoke'].dependsOn, [
    'native-build',
  ]);
  assert.deepEqual(candidate.targets['native-build'].dependsOn, ['build']);
  assert.ok(
    candidate.targets['rust-size-check'].inputs.includes(
      '{workspaceRoot}/**/*.rs',
    ),
  );
  assert.ok(
    candidate.targets['rust-size-check'].inputs.includes(
      '{workspaceRoot}/.gitignore',
    ),
  );
  assert.ok(
    candidate.targets['native-build'].outputs.includes(
      '{workspaceRoot}/target/debug/stellar-desktop.exe',
    ),
  );
}

test('native checks hash manifests, locks, toolchain, source, contracts and policy', () => {
  assertCacheInputs(project);
});

test('missing locks, source globs, build dependencies and cached smoke are rejected', () => {
  for (const input of [
    '{workspaceRoot}/Cargo.lock',
    '{workspaceRoot}/rust-toolchain.toml',
    '{projectRoot}/src-tauri/**/*',
  ]) {
    const fixture = structuredClone(project);
    fixture.namedInputs.native = fixture.namedInputs.native.filter(
      (value) => value !== input,
    );
    assert.throws(() => assertCacheInputs(fixture));
  }
  const cachedSmoke = structuredClone(project);
  cachedSmoke.targets['native-smoke'].cache = true;
  assert.throws(() => assertCacheInputs(cachedSmoke));
  const skippedBuild = structuredClone(project);
  skippedBuild.targets['native-build'].dependsOn = [];
  assert.throws(() => assertCacheInputs(skippedBuild));
});

test('normal host keeps decorations and only its explicit local readiness permission', () => {
  assert.equal(config.app.windows[0].decorations, true);
  assert.equal(config.app.windows[0].resizable, true);
  assert.equal(config.app.windows[0].devtools, false);
  assert.deepEqual(config.app.security.capabilities, ['desktop-main']);
  assert.deepEqual(capability.permissions, ['allow-shell-status']);
  assert.equal(capability.remote, undefined);
  assert.match(config.app.security.csp, /script-src 'self';/);
  assert.doesNotMatch(
    config.app.security.csp,
    /unsafe-eval|unsafe-inline|https:|\*/,
  );
});
