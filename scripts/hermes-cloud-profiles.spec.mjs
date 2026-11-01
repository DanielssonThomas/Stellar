import assert from 'node:assert/strict';
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  provisionCloudProfile,
  validateCloudConfig,
} from './hermes-cloud-profiles.mjs';

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

test('creates a profile at the path Hermes reports, without copying credentials', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stellar-cloud-profile-'));
  const profile = path.join(home, 'profiles', 'peon-cloud');
  let created = false;
  const calls = [];
  const commandRunner = (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'profile' && args[1] === 'show') {
      if (!created) throw new Error("Profile 'peon-cloud' does not exist.");
      return `Profile: peon-cloud\nPath: ${profile}\n`;
    }
    if (args[0] === 'profile' && args[1] === 'create') {
      created = true;
      return '';
    }
    if (args.at(-1) === 'model.default') return 'gpt-6-luna';
    if (args.at(-1) === 'model.provider') return 'openai-codex';
    if (args.includes('fallback')) return 'No fallback providers configured.';
    if (args.includes('tools')) return '✓ enabled skills';
    if (args.includes('prompt-size'))
      return JSON.stringify({
        toolsets_breakdown: [{ toolset: 'skills' }],
        skills_breakdown: [],
      });
    throw new Error(`Unexpected command: ${args.join(' ')}`);
  };
  try {
    const result = await provisionCloudProfile('peon', { commandRunner });
    assert.equal(result.model, 'gpt-6-luna');
    assert.ok(
      calls.some((call) => call.startsWith('profile create peon-cloud')),
    );
    assert.match(
      await readFile(path.join(profile, 'SOUL.md'), 'utf8'),
      /^# Peon/,
    );
    await assert.rejects(
      readFile(path.join(profile, '.env'), 'utf8'),
      /ENOENT/,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('replaces an existing active profile by exact lookup without creating another', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stellar-cloud-active-'));
  const profile = path.join(home, 'profiles', 'architect-cloud');
  const calls = [];
  const commandRunner = (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'profile' && args[1] === 'show')
      return `◆ Profile: architect-cloud\nPath: ${profile}\n`;
    if (args.at(-1) === 'model.default') return 'gpt-6.1-sol';
    if (args.at(-1) === 'model.provider') return 'openai-codex';
    if (args.includes('fallback')) return 'No fallback providers configured.';
    if (args.includes('tools')) return '✓ enabled skills';
    if (args.includes('prompt-size'))
      return JSON.stringify({
        toolsets_breakdown: [{ toolset: 'skills' }],
        skills_breakdown: [{ name: 'epic-planning' }],
      });
    throw new Error(`Unexpected command: ${args.join(' ')}`);
  };
  try {
    await assert.rejects(
      provisionCloudProfile('architect', { commandRunner }),
      /exists; pass --replace/,
    );
    const result = await provisionCloudProfile('architect', {
      replace: true,
      commandRunner,
    });
    assert.equal(result.profile, 'architect-cloud');
    assert.ok(!calls.some((call) => call.startsWith('profile create')));
    assert.match(
      await readFile(path.join(profile, 'config.yaml'), 'utf8'),
      /gpt-6\.1-sol/,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

for (const [name, override, expected] of [
  [
    'relative profile path',
    { profilePath: 'profiles/architect-cloud' },
    /relative profile path/,
  ],
  ['empty tool listing', { tools: '' }, /loaded route or toolsets/],
  [
    'unexpected enabled tool',
    { tools: '✓ enabled skills\n✓ enabled browser-use' },
    /loaded route or toolsets/,
  ],
  [
    'unexpected prompt tool',
    { toolsets: [{ toolset: 'terminal' }] },
    /loaded route or toolsets/,
  ],
  ['missing role skill', { skills: [] }, /loaded route or toolsets/],
  [
    'unavailable prompt inventory',
    { prompt: '{}' },
    /loaded route or toolsets/,
  ],
]) {
  test(`rejects ${name} during offline qualification`, async (t) => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'stellar-cloud-denial-'));
    t.after(() => rm(home, { recursive: true, force: true }));
    const profile = path.join(home, 'profiles', 'architect-cloud');
    const calls = [];
    const commandRunner = (args) => {
      calls.push(args);
      if (args[0] === 'profile' && args[1] === 'show')
        return `Profile: architect-cloud\nPath: ${override.profilePath ?? profile}\n`;
      if (args.at(-1) === 'model.default') return 'gpt-6.1-sol';
      if (args.at(-1) === 'model.provider') return 'openai-codex';
      if (args.includes('fallback')) return 'No fallback providers configured.';
      if (args.includes('tools')) return override.tools ?? '✓ enabled skills';
      if (args.includes('prompt-size'))
        return (
          override.prompt ??
          JSON.stringify({
            toolsets_breakdown: override.toolsets ?? [{ toolset: 'skills' }],
            skills_breakdown: override.skills ?? [{ name: 'epic-planning' }],
          })
        );
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    };
    await assert.rejects(
      provisionCloudProfile('architect', { replace: true, commandRunner }),
      expected,
    );
    assert.ok(
      calls.every((args) => !args.includes('chat') && !args.includes('run')),
    );
    if (override.profilePath)
      await assert.rejects(
        readFile(path.join(profile, 'config.yaml')),
        /ENOENT/,
      );
  });
}

for (const kind of ['profile junction', 'config symlink', 'config hardlink']) {
  test(`preserves external state behind a ${kind}`, async (t) => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'stellar-cloud-links-'));
    t.after(() => rm(home, { recursive: true, force: true }));
    const profile = path.join(home, 'profiles', 'peon-cloud');
    const outside = path.join(home, 'local-role');
    await mkdir(path.dirname(profile), { recursive: true });
    await mkdir(outside);
    const original = path.join(outside, 'config.yaml');
    await writeFile(original, 'preserve local model');
    try {
      if (kind === 'profile junction')
        await symlink(outside, profile, 'junction');
      else {
        await mkdir(profile);
        if (kind === 'config hardlink')
          await link(original, path.join(profile, 'config.yaml'));
        else await symlink(original, path.join(profile, 'config.yaml'), 'file');
      }
    } catch (error) {
      if (error.code === 'EPERM') return t.skip('link creation unavailable');
      throw error;
    }
    const commandRunner = (args) => {
      if (args[0] === 'profile' && args[1] === 'show')
        return `Path: ${profile}\n`;
      if (args.at(-1) === 'model.default') return 'gpt-6-luna';
      if (args.at(-1) === 'model.provider') return 'openai-codex';
      if (args.includes('fallback')) return 'No fallback providers configured.';
      if (args.includes('tools')) return '✓ enabled skills';
      if (args.includes('prompt-size'))
        return JSON.stringify({
          toolsets_breakdown: [{ toolset: 'skills' }],
          skills_breakdown: [],
        });
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    };
    if (kind === 'config hardlink') {
      await provisionCloudProfile('peon', { replace: true, commandRunner });
      assert.match(
        await readFile(path.join(profile, 'config.yaml'), 'utf8'),
        /gpt-6-luna/,
      );
    } else {
      await assert.rejects(
        provisionCloudProfile('peon', { replace: true, commandRunner }),
        /unsafe file type/,
      );
    }
    assert.equal(await readFile(original, 'utf8'), 'preserve local model');
    assert.deepEqual(await readdir(outside), ['config.yaml']);
  });
}
