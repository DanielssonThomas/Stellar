import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  cp,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = path.dirname(fileURLToPath(import.meta.url));
const allowed = new Set(['architect', 'foreman', 'peon']);
const roleSkills = Object.freeze({
  architect: ['epic-planning'],
  foreman: ['technical-dispatch', 'code-review', 'reconciliation'],
  peon: [],
});

function run(executable, args, env) {
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    windowsHide: true,
    env,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      (result.stderr || result.stdout || `${executable} failed`).trim(),
    );
  return result.stdout.trim();
}

async function plainEntry(file, kind, allowMissing = false) {
  let entry;
  try {
    entry = await lstat(file);
  } catch (error) {
    if (allowMissing && error.code === 'ENOENT') return false;
    throw error;
  }
  if (
    entry.isSymbolicLink() ||
    (kind === 'file' && !entry.isFile()) ||
    (kind === 'directory' && !entry.isDirectory())
  )
    throw new Error(`Identity path has an unsafe file type: ${file}`);
  return true;
}

async function plainParents(root, destination) {
  let ancestor = path.parse(root).root;
  await plainEntry(ancestor, 'directory');
  for (const part of path
    .relative(ancestor, root)
    .split(path.sep)
    .filter(Boolean)) {
    ancestor = path.join(ancestor, part);
    await plainEntry(ancestor, 'directory');
  }
  const relative = path.relative(root, path.dirname(destination));
  if (relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error('Identity destination escapes its Hermes root.');
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    await plainEntry(current, 'directory', true);
  }
}

async function plainTree(directory) {
  if (!(await plainEntry(directory, 'directory', true))) return;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) await plainTree(child);
    else await plainEntry(child, 'file');
  }
}

async function installIdentityFile(source, destination, force) {
  await plainEntry(destination, 'file', true);
  if (!force) {
    await copyFile(source, destination, constants.COPYFILE_EXCL);
    return;
  }
  const staged = path.join(
    path.dirname(destination),
    `.stellar-identity-${randomUUID()}.tmp`,
  );
  try {
    await copyFile(source, staged, constants.COPYFILE_EXCL);
    await rename(staged, destination);
  } finally {
    await unlink(staged).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

async function copyIdentity(role, home, force) {
  const template = path.join(sourceRoot, 'templates', role);
  for (const [sourceFile, destinationFile] of [
    ['soul.md', 'SOUL.md'],
    ['config.yaml', 'config.yaml'],
  ]) {
    const destination = path.join(home, destinationFile);
    await plainParents(path.dirname(path.dirname(home)), destination);
    if ((await plainEntry(destination, 'file', true)) && !force)
      throw new Error(
        `${destination} already exists; refusing to overwrite runtime state.`,
      );
    await installIdentityFile(
      path.join(template, sourceFile),
      destination,
      force,
    );
  }
  const skillsRoot = path.join(home, 'skills', 'stellar');
  for (const skill of roleSkills[role]) {
    const destination = path.join(skillsRoot, skill);
    await plainParents(path.dirname(path.dirname(home)), destination);
    await plainTree(destination);
    if ((await plainEntry(destination, 'directory', true)) && !force)
      throw new Error(
        `${destination} already exists; refusing to overwrite runtime state.`,
      );
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(sourceRoot, 'skills', skill), destination, {
      recursive: true,
      errorOnExist: !force,
      force,
    });
  }
}

export async function provision({
  role,
  hermes = process.env.HERMES_BIN ?? 'hermes',
  hermesRoot = process.env.HERMES_ROOT,
  force = false,
  commandRunner = run,
}) {
  if (!allowed.has(role))
    throw new Error(
      'Only Architect and Foreman have dedicated Hermes profiles.',
    );
  if (!hermesRoot || !path.isAbsolute(hermesRoot))
    throw new Error('Set HERMES_ROOT to the installed Hermes home.');
  const env = { ...process.env, HERMES_HOME: hermesRoot };
  if (role === 'peon') {
    const home = path.join(hermesRoot, 'profiles', role);
    const configPath = path.join(home, 'config.yaml');
    const soulPath = path.join(home, 'SOUL.md');
    await plainParents(hermesRoot, configPath);
    await plainEntry(configPath, 'file');
    await plainEntry(soulPath, 'file', true);
    const configBefore = await readFile(configPath);
    let previousSoul = null;
    try {
      previousSoul = await readFile(soulPath);
      if (!force)
        throw new Error(
          `${soulPath} already exists; explicit --replace-identity-files is required.`,
        );
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (previousSoul) {
      const backup = path.join(
        home,
        'backups',
        'stellar-org',
        'SOUL.md.previous',
      );
      await plainParents(hermesRoot, backup);
      await mkdir(path.dirname(backup), { recursive: true });
      await plainParents(hermesRoot, backup);
      if (!(await plainEntry(backup, 'file', true)))
        await copyFile(soulPath, backup, constants.COPYFILE_EXCL);
    }
    await installIdentityFile(
      path.join(sourceRoot, 'templates', role, 'soul.md'),
      soulPath,
      force,
    );
    const loadedSoul = await readFile(soulPath, 'utf8');
    const configAfter = await readFile(configPath);
    if (!loadedSoul.startsWith('# Peon'))
      throw new Error('Peon SOUL identity does not match its role.');
    if (!configBefore.equals(configAfter))
      throw new Error(
        'Peon runtime config changed during identity provisioning.',
      );
    const prompt = JSON.parse(
      await commandRunner(hermes, ['-p', role, 'prompt-size', '--json'], env),
    );
    return {
      role,
      home,
      soulFileValidated: true,
      configUnchanged: true,
      qwenModelPreserved: configAfter.includes(
        Buffer.from('Qwen3.5-4B-Q4_K_M'),
      ),
      historicalSoulBackedUp: Boolean(previousSoul),
      promptSizeBytes: prompt.system_prompt.bytes,
      credentialsCopied: false,
      inferenceStarted: false,
    };
  }
  const description =
    role === 'architect'
      ? 'Stellar engineering manager; coordinates Foreman and governs plans.'
      : 'Stellar senior engineering lead; reviews and dispatches bounded Peon work.';
  const command = async (args) => await commandRunner(hermes, args, env);
  const list = await command(['profile', 'list']);
  const existed = new RegExp(`^\\s*${role}\\s`, 'im').test(list);
  if (!existed)
    await command([
      'profile',
      'create',
      role,
      '--no-skills',
      '--no-alias',
      '--description',
      description,
    ]);
  const home = path.join(hermesRoot, 'profiles', role);
  await mkdir(home, { recursive: true });
  await copyIdentity(role, home, force || !existed);

  const loadedSoul = await readFile(path.join(home, 'SOUL.md'), 'utf8');
  const loadedConfig = await readFile(path.join(home, 'config.yaml'), 'utf8');
  if (!loadedSoul.startsWith(`# ${role[0].toUpperCase()}${role.slice(1)}`))
    throw new Error('Installed SOUL identity does not match the role.');
  if (/api[_-]?key|token\s*:/i.test(loadedConfig))
    throw new Error('Identity template must not contain credentials.');
  for (const skill of roleSkills[role])
    await stat(path.join(home, 'skills', 'stellar', skill, 'SKILL.md'));
  const details = await command(['-p', role, 'config']);
  if (!details.includes('__SET_APPROVED_'))
    throw new Error(
      'Profile no longer has its explicit unconfigured provider sentinel.',
    );
  const prompt = JSON.parse(
    await command(['-p', role, 'prompt-size', '--json']),
  );
  const tools = await command(['-p', role, 'tools', 'list']);
  const enabledToolsets = [
    ...tools.matchAll(/^\s*✓ enabled\s+([a-z_]+)/gm),
  ].map((match) => match[1]);
  const visibleToolsets = new Set(
    prompt.toolsets_breakdown.map((entry) => entry.toolset),
  );
  if (enabledToolsets.some((toolset) => toolset !== 'skills'))
    throw new Error(
      `Management profile exposes unexpected toolsets: ${enabledToolsets.filter((toolset) => toolset !== 'skills').join(', ')}.`,
    );
  if (enabledToolsets.length !== 1 || enabledToolsets[0] !== 'skills')
    throw new Error(
      'Management profiles may expose only the skills toolset until trusted orchestration is installed.',
    );
  if (
    !roleSkills[role].every((skill) =>
      prompt.skills_breakdown.some((entry) => entry.name === skill),
    )
  )
    throw new Error('Hermes did not load every role-specific skill.');
  return {
    role,
    home,
    profileCreated: !existed,
    soulFileValidated: true,
    configLoaded: true,
    visibleToolsets: [...visibleToolsets],
    skillsLoaded: roleSkills[role],
    credentialsCopied: false,
    inferenceStarted: false,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [role, flag] = process.argv.slice(2);
  provision({ role, force: flag === '--replace-identity-files' })
    .then((result) =>
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`),
    )
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
