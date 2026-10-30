import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const roles = {
  architect: {
    profile: 'architect-cloud',
    model: 'gpt-6.1-sol',
    skills: ['epic-planning'],
  },
  foreman: {
    profile: 'foreman-cloud',
    model: 'gpt-6.1-sol',
    skills: ['technical-dispatch', 'code-review', 'reconciliation'],
  },
  peon: { profile: 'peon-cloud', model: 'gpt-6-luna', skills: [] },
};

function hermes(args) {
  const result = spawnSync('hermes', args, {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      (result.stderr || result.stdout || String(result.error)).trim(),
    );
  return result.stdout.trim();
}

export function validateCloudConfig(role, config) {
  const selected = roles[role];
  if (!selected) throw new Error(`Unknown role: ${role}`);
  if (
    !new RegExp(
      `^  default: ${selected.model.replaceAll('.', '\\.')}\\r?$`,
      'm',
    ).test(config) ||
    !/^  provider: openai-codex\r?$/m.test(config) ||
    !/^fallback_providers: \[\]\r?$/m.test(config)
  )
    throw new Error(`${role}: unexpected model, provider, or fallback route`);
  if (
    !/^auxiliary:\r?\n  title_generation:\r?\n    enabled: false\r?$/m.test(
      config,
    )
  )
    throw new Error(`${role}: auxiliary title inference must be disabled`);
  for (const toolset of [
    'terminal',
    'file',
    'code_execution',
    'browser',
    'connections',
    'delegation',
    'memory',
  ])
    if (!new RegExp(`^    - ${toolset}\\r?$`, 'm').test(config))
      throw new Error(`${role}: ${toolset} must be disabled`);
  if (/api[_-]?key|access_token|refresh_token/i.test(config))
    throw new Error(`${role}: config must contain no credential fields`);
}

export async function provisionCloudProfile(
  role,
  { replace = false, home = process.env.HERMES_HOME || 'D:\\Hermes' } = {},
) {
  const selected = roles[role];
  if (!selected) throw new Error(`Unknown role: ${role}`);
  const source = path.join(root, 'config', 'hermes-cloud', role, 'config.yaml');
  const config = await readFile(source, 'utf8');
  validateCloudConfig(role, config);
  const profiles = hermes(['profile', 'list']);
  const exists = new RegExp(`^\\s*${selected.profile}\\s`, 'm').test(profiles);
  if (exists && !replace)
    throw new Error(`${selected.profile} exists; pass --replace after review`);
  if (!exists)
    hermes([
      'profile',
      'create',
      selected.profile,
      '--no-skills',
      '--no-alias',
      '--description',
      `Stellar ${role} cloud role; host authority remains governed.`,
    ]);
  const destination = path.join(home, 'profiles', selected.profile);
  await mkdir(destination, { recursive: true });
  await writeFile(path.join(destination, 'config.yaml'), config, 'utf8');
  await cp(
    path.join(
      root,
      'tools',
      'policy',
      'engineering-org',
      'templates',
      role,
      'soul.md',
    ),
    path.join(destination, 'SOUL.md'),
    { force: true },
  );
  for (const skill of selected.skills) {
    const skillDestination = path.join(destination, 'skills', 'stellar', skill);
    await mkdir(path.dirname(skillDestination), { recursive: true });
    await cp(
      path.join(root, 'tools', 'policy', 'engineering-org', 'skills', skill),
      skillDestination,
      { recursive: true, force: true },
    );
  }
  const loadedModel = hermes([
    '-p',
    selected.profile,
    'config',
    'get',
    'model.default',
  ]);
  const loadedProvider = hermes([
    '-p',
    selected.profile,
    'config',
    'get',
    'model.provider',
  ]);
  const loadedFallback = hermes(['-p', selected.profile, 'fallback', 'list']);
  const toolsets = hermes(['-p', selected.profile, 'tools', 'list']);
  if (
    loadedModel !== selected.model ||
    loadedProvider !== 'openai-codex' ||
    !loadedFallback.includes('No fallback providers configured.') ||
    [...toolsets.matchAll(/^\s*✓ enabled\s+([a-z_]+)/gm)].some(
      (match) => match[1] !== 'skills',
    )
  )
    throw new Error(
      `${selected.profile}: loaded route or toolsets differ from template`,
    );
  return {
    profile: selected.profile,
    provider: loadedProvider,
    model: loadedModel,
    inferenceStarted: false,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  provisionCloudProfile(process.argv[2], {
    replace: process.argv.includes('--replace'),
  })
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
