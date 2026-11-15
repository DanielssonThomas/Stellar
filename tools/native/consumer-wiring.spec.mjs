import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(
  new URL(
    '../../apps/stellar-desktop/src-tauri/src/ivy/mod.rs',
    import.meta.url,
  ),
  'utf8',
);
const manifest = readFileSync(
  new URL('../../apps/stellar-desktop/src-tauri/Cargo.toml', import.meta.url),
  'utf8',
);
const ui = readFileSync(
  new URL('./consent-ui/Cargo.toml', import.meta.url),
  'utf8',
);

function requireTestOnly(moduleSource, cargo) {
  assert.equal(
    (moduleSource.match(/mod native_consent_client;/g) ?? []).length,
    1,
  );
  assert.match(moduleSource, /#\[cfg\(test\)\]\s*mod native_consent_client;/);
  const dev = /\[dev-dependencies\]([^]*?)(?=\n\[|$)/.exec(cargo)?.[1] ?? '';
  for (const crate of ['stellar-consent-broker', 'stellar-consent-ui']) {
    assert.ok(
      dev.includes(
        `${crate} = { path = "../../../tools/native/${crate.slice(8)}" }`,
      ),
    );
    assert.equal(
      cargo.split(crate).length - 1,
      1,
      'No parallel production consent dependency',
    );
  }
}

test('consumer composition is test-only without a producer dependency in UI', () => {
  requireTestOnly(source, manifest);
  assert.ok(!ui.includes('stellar-consent-broker'));
  assert.ok(!ui.includes('[workspace]'));
});

test('missing test gate and production dependency promotion refuse', () => {
  assert.throws(() =>
    requireTestOnly(
      source.replace(
        /#\[cfg\(test\)\]\s*mod native_consent_client;/,
        'mod native_consent_client;',
      ),
      manifest,
    ),
  );
  assert.throws(() =>
    requireTestOnly(
      source,
      manifest.replace('[dev-dependencies]', '[dependencies]'),
    ),
  );
  assert.throws(() =>
    requireTestOnly(source + '\nmod native_consent_client;', manifest),
  );
});
