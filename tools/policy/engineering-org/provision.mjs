import { spawnSync } from 'node:child_process';
import { cp, copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = path.dirname(fileURLToPath(import.meta.url));
const allowed = new Set(['architect', 'foreman']);
const roleSkills = Object.freeze({
  architect: ['epic-planning'],
  foreman: ['technical-dispatch', 'code-review', 'reconciliation'],
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

async function copyIdentity(role, home, force) {
  const template = path.join(sourceRoot, 'templates', role);
  for (const [sourceFile, destinationFile] of [
    ['soul.md', 'SOUL.md'],
    ['config.yaml', 'config.yaml'],
  ]) {
    const destination = path.join(home, destinationFile);
    try {
      await stat(destination);
      if (!force)
        throw new Error(
          `${destination} already exists; refusing to overwrite runtime state.`,
        );
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await copyFile(path.join(template, sourceFile), destination, force ? 0 : 1);
  }
  const skillsRoot = path.join(home, 'skills', 'stellar');
  for (const skill of roleSkills[role]) {
    const destination = path.join(skillsRoot, skill);
    try {
      await stat(destination);
      if (!force)
        throw new Error(
          `${destination} already exists; refusing to overwrite runtime state.`,
        );
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
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
  return {
    role,
    home,
    profileCreated: !existed,
    soulLoaded: true,
    configLoaded: true,
    skillsInstalled: roleSkills[role],
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
