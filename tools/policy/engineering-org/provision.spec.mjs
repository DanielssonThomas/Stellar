import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { provision } from './provision.mjs';

test('creates an isolated credential-free Hermes profile and validates loaded files', async () => {
  const hermesRoot = await mkdtemp(
    path.join(os.tmpdir(), 'stellar-hermes-org-'),
  );
  const calls = [];
  try {
    const result = await provision({
      role: 'architect',
      hermes: 'fake-hermes',
      hermesRoot,
      commandRunner: async (_executable, args, env) => {
        calls.push(args);
        if (args[0] === 'profile' && args[1] === 'list')
          return 'Profile\n default Model\n';
        if (args[0] === 'profile' && args[1] === 'create') {
          const home = path.join(env.HERMES_HOME, 'profiles', 'architect');
          await mkdir(home, { recursive: true });
          await writeFile(path.join(home, 'SOUL.md'), 'generated default');
          await writeFile(path.join(home, 'config.yaml'), 'generated default');
          await writeFile(path.join(home, '.env'), 'preserve-this-secret');
          return '';
        }
        if (args[0] === '-p' && args.includes('prompt-size'))
          return JSON.stringify({
            toolsets_breakdown: [{ toolset: 'skills' }],
            skills_breakdown: [{ name: 'epic-planning' }],
          });
        if (args[0] === '-p' && args.includes('tools'))
          return '✓ enabled  skills 📚 Skills\n✗ disabled terminal\n';
        if (args[0] === '-p' && args[1] === 'architect')
          return await readFile(
            path.join(env.HERMES_HOME, 'profiles', 'architect', 'config.yaml'),
            'utf8',
          );
        throw new Error('Unexpected Hermes command.');
      },
    });
    assert.equal(result.profileCreated, true);
    assert.equal(result.credentialsCopied, false);
    assert.equal(result.inferenceStarted, false);
    assert.deepEqual(result.visibleToolsets, ['skills']);
    assert.match(
      await readFile(
        path.join(hermesRoot, 'profiles', 'architect', 'SOUL.md'),
        'utf8',
      ),
      /^# Architect/,
    );
    assert.equal(
      await readFile(
        path.join(hermesRoot, 'profiles', 'architect', '.env'),
        'utf8',
      ),
      'preserve-this-secret',
    );
    assert.ok(
      calls.some((args) => args[0] === 'profile' && args[1] === 'create'),
    );
    assert.ok(
      await readFile(
        path.join(
          hermesRoot,
          'profiles',
          'architect',
          'skills',
          'stellar',
          'epic-planning',
          'SKILL.md',
        ),
        'utf8',
      ),
    );
  } finally {
    await rm(hermesRoot, { recursive: true, force: true });
  }
});

test('refuses to overwrite an existing runtime identity without explicit replacement', async () => {
  const hermesRoot = await mkdtemp(
    path.join(os.tmpdir(), 'stellar-hermes-org-'),
  );
  try {
    const profile = path.join(hermesRoot, 'profiles', 'foreman');
    await mkdir(profile, { recursive: true });
    await writeFile(path.join(profile, 'SOUL.md'), 'existing state');
    await writeFile(path.join(profile, 'config.yaml'), 'existing config');
    await assert.rejects(
      provision({
        role: 'foreman',
        hermesRoot,
        commandRunner: async (_exe, args) =>
          args[0] === 'profile' ? ' foreman existing\n' : 'ok',
      }),
      /refusing to overwrite runtime state/,
    );
    assert.equal(
      await readFile(path.join(profile, 'SOUL.md'), 'utf8'),
      'existing state',
    );
  } finally {
    await rm(hermesRoot, { recursive: true, force: true });
  }
});

test('updates Peon identity while preserving its existing Qwen config and backing up the prior identity', async () => {
  const hermesRoot = await mkdtemp(
    path.join(os.tmpdir(), 'stellar-hermes-peon-'),
  );
  try {
    const profile = path.join(hermesRoot, 'profiles', 'peon');
    await mkdir(profile, { recursive: true });
    const config = 'model:\n  default: Qwen3.5-4B-Q4_K_M\n  provider: custom\n';
    await writeFile(path.join(profile, 'config.yaml'), config);
    await writeFile(path.join(profile, 'SOUL.md'), 'historical Peon identity');
    await assert.rejects(
      provision({ role: 'peon', hermesRoot }),
      /explicit --replace-identity-files/,
    );
    const result = await provision({
      role: 'peon',
      hermesRoot,
      force: true,
      commandRunner: async (_exe, args) => {
        assert.deepEqual(args, ['-p', 'peon', 'prompt-size', '--json']);
        return JSON.stringify({ system_prompt: { bytes: 1000 } });
      },
    });
    assert.equal(result.configUnchanged, true);
    assert.equal(result.qwenModelPreserved, true);
    assert.equal(result.historicalSoulBackedUp, true);
    assert.equal(
      await readFile(path.join(profile, 'config.yaml'), 'utf8'),
      config,
    );
    assert.equal(
      await readFile(
        path.join(profile, 'backups', 'stellar-org', 'SOUL.md.previous'),
        'utf8',
      ),
      'historical Peon identity',
    );
    assert.match(
      await readFile(path.join(profile, 'SOUL.md'), 'utf8'),
      /^# Peon/,
    );
  } finally {
    await rm(hermesRoot, { recursive: true, force: true });
  }
});

test('rejects a Peon SOUL symlink during replacement without writing its target', async (t) => {
  const hermesRoot = await mkdtemp(
    path.join(os.tmpdir(), 'stellar-hermes-symlink-'),
  );
  try {
    const profile = path.join(hermesRoot, 'profiles', 'peon');
    await mkdir(profile, { recursive: true });
    const outside = path.join(hermesRoot, 'outside.md');
    await writeFile(outside, 'preserve this file');
    await writeFile(
      path.join(profile, 'config.yaml'),
      'model: Qwen3.5-4B-Q4_K_M',
    );
    try {
      await symlink(outside, path.join(profile, 'SOUL.md'), 'file');
    } catch (error) {
      if (error.code === 'EPERM') {
        t.skip('file symlinks unavailable');
        return;
      }
      throw error;
    }
    await assert.rejects(
      provision({ role: 'peon', hermesRoot, force: true }),
      /unsafe file type/,
    );
    assert.equal(await readFile(outside, 'utf8'), 'preserve this file');
  } finally {
    await rm(hermesRoot, { recursive: true, force: true });
  }
});

test('rejects a Peon backup parent junction before copying identity', async (t) => {
  const hermesRoot = await mkdtemp(
    path.join(os.tmpdir(), 'stellar-hermes-junction-'),
  );
  try {
    const profile = path.join(hermesRoot, 'profiles', 'peon');
    const outside = path.join(hermesRoot, 'outside');
    await mkdir(profile, { recursive: true });
    await mkdir(outside);
    await writeFile(
      path.join(profile, 'config.yaml'),
      'model: Qwen3.5-4B-Q4_K_M',
    );
    await writeFile(path.join(profile, 'SOUL.md'), 'historical identity');
    try {
      await symlink(outside, path.join(profile, 'backups'), 'junction');
    } catch (error) {
      if (error.code === 'EPERM') {
        t.skip('junctions unavailable');
        return;
      }
      throw error;
    }
    await assert.rejects(
      provision({ role: 'peon', hermesRoot, force: true }),
      /unsafe file type/,
    );
    assert.deepEqual(await readdir(outside), []);
    assert.equal(
      await readFile(path.join(profile, 'SOUL.md'), 'utf8'),
      'historical identity',
    );
  } finally {
    await rm(hermesRoot, { recursive: true, force: true });
  }
});
