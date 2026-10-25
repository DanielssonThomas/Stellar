import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
