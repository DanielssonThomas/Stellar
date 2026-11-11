import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const delegates = new Map([
  ['peon-cloud', 'gpt-6-luna'],
  ['foreman-cloud', 'gpt-6.1-sol'],
]);
const provider = 'openai-codex';

export function checkStellarDelegate(
  profile,
  { executable = 'hermes', run = spawnSync } = {},
) {
  const model = delegates.get(profile);
  if (!model) {
    throw new Error('Choose peon-cloud or foreman-cloud.');
  }

  function call(args, failureMessage) {
    const result = run(executable, ['-p', profile, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 64 * 1024,
    });
    if (result.error?.code === 'ETIMEDOUT') {
      throw new Error(`${profile}: the Hermes readiness check timed out.`);
    }
    if (result.error || result.signal) {
      throw new Error(
        `${profile}: could not run the Hermes CLI readiness check.`,
      );
    }
    if (result.status !== 0) {
      throw new Error(failureMessage);
    }
    return result.stdout.trim();
  }

  const configurationError = `${profile}: expected the personal cloud profile with ${provider}/${model}. Verify its Hermes profile configuration.`;
  const actualProvider = call(
    ['config', 'get', 'model.provider'],
    configurationError,
  );
  const actualModel = call(
    ['config', 'get', 'model.default'],
    configurationError,
  );
  if (actualProvider !== provider || actualModel !== model) {
    throw new Error(configurationError);
  }

  const readinessError = `${profile}: Hermes could not verify live Codex access. Check connectivity and the shared Hermes Codex sign-in before claiming or starting this assignment.`;
  const usage = call(
    ['usage', '--provider', provider, '--json'],
    readinessError,
  );
  let account;
  try {
    account = JSON.parse(usage);
  } catch {
    throw new Error(readinessError);
  }
  if (account?.provider !== provider || account.unavailable_reason) {
    throw new Error(readinessError);
  }

  return { profile, provider, model, ready: true };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const [profile, flag, executable, ...extra] = process.argv.slice(2);
    if (extra.length || (flag && (flag !== '--hermes' || !executable))) {
      throw new Error(
        'Usage: node scripts/check-stellar-delegate.mjs <profile> [--hermes <executable>]',
      );
    }
    process.stdout.write(
      `${JSON.stringify(checkStellarDelegate(profile, { executable }))}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
