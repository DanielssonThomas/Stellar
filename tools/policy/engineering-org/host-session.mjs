import { spawn } from 'node:child_process';
import { readFile, mkdir, lstat } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { digest, requireValue } from './planning-evidence.mjs';

const script = fileURLToPath(new URL('./inert-role.mjs', import.meta.url));
const roles = Object.freeze({
  dispatch: 'foreman',
  implement: 'peon',
  verify: 'verifier',
  review: 'foreman',
  reconcile: 'foreman',
});
const receipts = new WeakSet();
const recipes = new WeakSet();
const allowedFaults = [
  null,
  'hang',
  'oversize',
  'provider-failure',
  'defect',
  'foreign-channel',
];

export function assertHostRecipe(recipe, phase, role) {
  requireValue(
    recipes.has(recipe) && recipe.phase === phase && recipe.role === role,
    'Recipe does not grant the required host role.',
  );
  return recipe;
}

function immutable(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

export function assertHostSessionReceipt(
  receipt,
  { phase, nonce, packetDigest, allowUnconfirmed = false } = {},
) {
  requireValue(
    receipts.has(receipt) &&
      (allowUnconfirmed || receipt.terminated === true) &&
      (!phase || receipt.phase === phase) &&
      (!nonce || receipt.nonce === nonce) &&
      (!packetDigest || receipt.packetDigest === packetDigest),
    'Untrusted or mismatched host session receipt.',
  );
  return receipt;
}

export async function registerHostRecipe({
  phase,
  role,
  entryPoint,
  expectedDigest,
  mode,
}) {
  requireValue(
    typeof phase === 'string' &&
      /^[a-z][a-z-]{1,40}$/.test(phase) &&
      ['architect', 'foreman', 'peon', 'verifier'].includes(role) &&
      typeof entryPoint === 'string' &&
      path.isAbsolute(entryPoint) &&
      mode === 'inert',
    'Only host-registered inert recipes are currently qualified.',
  );
  const info = await lstat(entryPoint);
  const actual = createHash('sha256')
    .update(await readFile(entryPoint))
    .digest('hex');
  requireValue(
    info.isFile() && !info.isSymbolicLink() && actual === expectedDigest,
    'Trusted recipe bytes do not match their host pin.',
  );
  const recipe = Object.freeze({
    phase,
    role,
    entryPoint,
    digest: actual,
    mode,
  });
  recipes.add(recipe);
  return recipe;
}

export async function inertRecipe(phase) {
  requireValue(Object.hasOwn(roles, phase), 'Unknown inert role recipe.');
  return registerHostRecipe({
    phase,
    role: roles[phase],
    entryPoint: script,
    expectedDigest: createHash('sha256')
      .update(await readFile(script))
      .digest('hex'),
    mode: 'inert',
  });
}

export async function runHostSession({
  recipe,
  packet,
  workspace,
  nonce = randomUUID(),
  timeoutMs = 2000,
  fault = null,
  onSpawn = async () => undefined,
  signal,
}) {
  requireValue(
    recipes.has(recipe) &&
      typeof nonce === 'string' &&
      /^[a-f0-9-]{36}$/.test(nonce),
    'Unknown host recipe handle or session identity.',
  );
  const { phase, role, entryPoint, digest: recipeDigest } = recipe;
  requireValue(
    Number.isSafeInteger(timeoutMs) &&
      timeoutMs > 0 &&
      timeoutMs <= 10_000 &&
      allowedFaults.includes(fault),
    'Inert session limits or fixture fault are invalid.',
  );
  digest(packet);
  const snapshot = immutable(JSON.parse(JSON.stringify(packet)));
  const packetDigest = digest(snapshot);
  requireValue(
    Buffer.byteLength(JSON.stringify(snapshot)) <= 32_768,
    'Session packet exceeds its byte bound.',
  );
  requireValue(
    createHash('sha256')
      .update(await readFile(entryPoint))
      .digest('hex') === recipeDigest,
    'Trusted role recipe changed.',
  );
  await mkdir(workspace, { recursive: true });
  return new Promise((resolve) => {
    const env = {};
    for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR'])
      if (process.env[key]) env[key] = process.env[key];
    const child = spawn(process.execPath, [entryPoint, phase, nonce], {
      cwd: workspace,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let response = null;
    let failure = null;
    let bytes = 0;
    let messages = 0;
    let finished = false;
    let cleanupTimer;
    const stop = (reason) => {
      failure ??= reason;
      try {
        child.kill();
      } catch {
        /* A close event is the termination evidence. */
      }
      cleanupTimer ??= setTimeout(() => finish(null, null, false), 2000);
    };
    const abort = () => stop('cancelled');
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    const output = (chunk) => {
      bytes += chunk.length;
      if (bytes > 32_768) stop('output-limit');
    };
    child.stdout.on('data', output);
    child.stderr.on('data', output);
    child.on('message', (message) => {
      messages += 1;
      if (
        messages !== 1 ||
        !message ||
        Buffer.byteLength(JSON.stringify(message)) > 32_768 ||
        message.nonce !== nonce
      )
        return stop('invalid-channel-output');
      if (message.error)
        return stop(
          `provider-${message.error === 'quota' ? 'quota' : 'unknown'}`,
        );
      if (message.result === undefined) return stop('invalid-channel-output');
      response = message.result;
    });
    child.on('error', () => {
      failure ??= 'launch-failed';
    });
    child.once('spawn', async () => {
      try {
        await onSpawn({
          pid: child.pid,
          nonce,
          phase,
          role,
          recipeDigest,
          packetDigest,
        });
        if (signal?.aborted) stop('cancelled');
        if (!failure) child.send({ nonce, packet: snapshot, fault });
      } catch {
        stop('launch-record-failed');
      }
    });
    function finish(code, exitSignal, terminated) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(cleanupTimer);
      signal?.removeEventListener('abort', abort);
      const receipt = immutable({
        schemaVersion: 1,
        mode: 'inert',
        phase,
        role,
        nonce,
        pid: child.pid ?? null,
        recipeDigest,
        packetDigest,
        terminated,
        status:
          failure || code !== 0 || response === null ? 'failed' : 'completed',
        failure:
          failure ?? (code !== 0 || response === null ? 'child-failed' : null),
        exitCode: code,
        signal: exitSignal,
        result: response,
        usage: { modelTokens: 0, requests: 0 },
      });
      receipts.add(receipt);
      resolve(receipt);
    }
    child.once('close', (code, exitSignal) => finish(code, exitSignal, true));
  });
}

export function liveRecipe() {
  throw new Error(
    'Live management and generic private execution recipes are not qualified; issue #101 must activate a reviewed adapter.',
  );
}
