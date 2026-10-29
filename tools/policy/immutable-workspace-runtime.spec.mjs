import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('offline immutable capture and collection reject unsafe source and output', (t) => {
  const script = fileURLToPath(
    new URL('./immutable-workspace.spec.py', import.meta.url),
  );
  let command = 'python3';
  let args = [script];
  if (process.platform === 'win32') {
    const match = /^([A-Za-z]):\\(.*)$/.exec(script);
    assert.ok(match, 'Expected a local Windows drive path for WSL test');
    const linuxPath = `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll('\\', '/')}`;
    command = 'wsl.exe';
    args = [
      '--distribution',
      'Ubuntu',
      '--user',
      'peon',
      '--exec',
      'python3',
      linuxPath,
    ];
  }
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 256 * 1024,
  });
  if (result.error?.code === 'ENOENT' && process.platform === 'win32') {
    t.skip('WSL is unavailable on this Windows host.');
    return;
  }
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /Ran 5 tests/);
});
