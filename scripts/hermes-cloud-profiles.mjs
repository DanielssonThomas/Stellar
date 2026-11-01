import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  plainEntry,
  plainParents,
  plainTree,
  installIdentityFile,
} from '../tools/policy/engineering-org/identity-files.mjs';

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
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  if (
    !result.error &&
    result.status !== 0 &&
    args[0] === 'profile' &&
    args[1] === 'show' &&
    `${result.stderr}\n${result.stdout}`.includes(
      `Profile '${args[2]}' does not exist.`,
    )
  )
    throw new Error('Profile does not exist.');
  if (result.error || result.status !== 0)
    throw new Error('Hermes offline profile inspection failed.');
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
    !/^ {2}provider: openai-codex\r?$/m.test(config) ||
    !/^fallback_providers: \[\]\r?$/m.test(config)
  )
    throw new Error(`${role}: unexpected model, provider, or fallback route`);
  if (
    !/^auxiliary:\r?\n {2}title_generation:\r?\n {4}enabled: false\r?$/m.test(
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
  { replace = false, commandRunner = hermes } = {},
) {
  const selected = roles[role];
  if (!selected) throw new Error(`Unknown role: ${role}`);
  const source = path.join(root, 'config', 'hermes-cloud', role, 'config.yaml');
  const config = await readFile(source, 'utf8');
  validateCloudConfig(role, config);
  let details;
  try {
    details = commandRunner(['profile', 'show', selected.profile]);
  } catch (error) {
    if (!/does not exist/i.test(error.message)) throw error;
  }
  const exists = Boolean(details);
  if (exists && !replace)
    throw new Error(`${selected.profile} exists; pass --replace after review`);
  if (!exists)
    commandRunner([
      'profile',
      'create',
      selected.profile,
      '--no-skills',
      '--no-alias',
      '--description',
      `Stellar ${role} cloud role; host authority remains governed.`,
    ]);
  details ??= commandRunner(['profile', 'show', selected.profile]);
  const match = /^Path:\s+(.+)\r?$/m.exec(details);
  if (!match)
    throw new Error(
      `${selected.profile}: Hermes did not report a profile path`,
    );
  const reportedPath = match[1].trim();
  if (!path.isAbsolute(reportedPath))
    throw new Error(
      `${selected.profile}: Hermes reported a relative profile path`,
    );
  const destination = path.resolve(reportedPath);
  if (
    path.basename(destination) !== selected.profile ||
    path.basename(path.dirname(destination)) !== 'profiles'
  )
    throw new Error(
      `${selected.profile}: Hermes reported an unexpected profile path`,
    );
  const profileRoot = path.dirname(path.dirname(destination));
  for (const filename of ['config.yaml', 'SOUL.md']) {
    const file = path.join(destination, filename);
    await plainParents(profileRoot, file);
    await plainEntry(file, 'file', true);
  }
  for (const skill of selected.skills) {
    const skillDestination = path.join(destination, 'skills', 'stellar', skill);
    await plainParents(profileRoot, skillDestination);
    await plainTree(skillDestination);
  }
  await mkdir(destination, { recursive: true });
  await installIdentityFile(
    source,
    path.join(destination, 'config.yaml'),
    true,
  );
  await installIdentityFile(
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
    true,
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
  const loadedModel = commandRunner([
    '-p',
    selected.profile,
    'config',
    'get',
    'model.default',
  ]);
  const loadedProvider = commandRunner([
    '-p',
    selected.profile,
    'config',
    'get',
    'model.provider',
  ]);
  const loadedFallback = commandRunner([
    '-p',
    selected.profile,
    'fallback',
    'list',
  ]);
  const toolsets = commandRunner(['-p', selected.profile, 'tools', 'list']);
  const enabledToolsets = [
    ...toolsets.matchAll(/^\s*✓ enabled\s+([a-z_-]+)/gm),
  ].map((match) => match[1]);
  const prompt = JSON.parse(
    commandRunner(['-p', selected.profile, 'prompt-size', '--json']),
  );
  if (
    loadedModel !== selected.model ||
    loadedProvider !== 'openai-codex' ||
    !loadedFallback.includes('No fallback providers configured.') ||
    enabledToolsets.length !== 1 ||
    enabledToolsets[0] !== 'skills' ||
    !Array.isArray(prompt.toolsets_breakdown) ||
    prompt.toolsets_breakdown.some((entry) => entry?.toolset !== 'skills') ||
    !Array.isArray(prompt.skills_breakdown) ||
    !selected.skills.every((skill) =>
      prompt.skills_breakdown.some((entry) => entry?.name === skill),
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
