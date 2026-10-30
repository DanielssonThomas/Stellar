import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { validateCloudConfig } from './hermes-cloud-profiles.mjs';

for (const role of ['architect', 'foreman', 'peon']) {
  test(`${role} cloud route keeps a single subscription provider and disabled direct tools`, async () => {
    const config = await readFile(
      path.join('config', 'hermes-cloud', role, 'config.yaml'),
      'utf8',
    );
    assert.doesNotThrow(() => validateCloudConfig(role, config));
    assert.throws(
      () =>
        validateCloudConfig(
          role,
          config.replace(
            'fallback_providers: []',
            'fallback_providers:\n  - provider: openai',
          ),
        ),
      /fallback/,
    );
    assert.throws(
      () => validateCloudConfig(role, config.replace('    - terminal\n', '')),
      /terminal/,
    );
  });
}
