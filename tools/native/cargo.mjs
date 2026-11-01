import { spawnSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { nativeSmokeSucceeded } from './smoke-result.mjs';

const action = process.argv[2];
const root = resolve(import.meta.dirname, '../..');
const env = { ...process.env };
env.CARGO_TARGET_DIR = resolve(root, 'target');
const args = {
  fmt: ['fmt', '--all', '--', '--check'],
  clippy: [
    'clippy',
    '--locked',
    '--workspace',
    '--all-targets',
    '--',
    '-D',
    'warnings',
  ],
  test: ['test', '--locked', '--workspace'],
  build: [
    'build',
    '--locked',
    '-p',
    'stellar-desktop',
    '--features',
    'custom-protocol',
  ],
  'contract-check': [
    'run',
    '--locked',
    '--quiet',
    '-p',
    'stellar-desktop',
    '--bin',
    'export-contracts',
  ],
  'contract-generate': [
    'run',
    '--locked',
    '--quiet',
    '-p',
    'stellar-desktop',
    '--bin',
    'export-contracts',
  ],
  size: ['run', '--locked', '--quiet', '-p', 'stellar-rust-size', '--', root],
};

function cargo(command, capture = false) {
  const result = spawnSync('cargo', command, {
    cwd: root,
    env,
    windowsHide: true,
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result.stdout;
}

if (action === 'smoke') {
  if (process.platform !== 'win32')
    throw new Error('Native smoke requires Windows + WebView2');
  env.CARGO_TARGET_DIR = resolve(root, 'target/smoke');
  env.TAURI_CONFIG = JSON.stringify({
    app: {
      security: {
        capabilities: [
          {
            identifier: 'desktop-smoke',
            windows: ['main'],
            permissions: [
              'allow-shell-status',
              'allow-app-info',
              'core:event:allow-listen',
              'core:event:allow-unlisten',
              'allow-smoke-result',
            ],
          },
        ],
      },
    },
  });
  cargo([
    'build',
    '--locked',
    '-p',
    'stellar-desktop',
    '--features',
    'custom-protocol,native-smoke',
  ]);
  rmSync(resolve(root, 'artifacts/native/smoke.json'), { force: true });
  const child = spawn(
    resolve(env.CARGO_TARGET_DIR, 'debug/stellar-desktop.exe'),
    [],
    {
      cwd: root,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  );
  let timedOut = false;
  let output = '';
  child.stdout.on('data', (chunk) => {
    if (output.length + chunk.length > 65_536) {
      timedOut = true;
      child.kill();
    } else output += chunk.toString('utf8');
  });
  const deadline = setTimeout(() => {
    timedOut = true;
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    console.error('Native WebView smoke timed out after 30 seconds');
  }, 30_000);
  child.on('error', (error) => {
    clearTimeout(deadline);
    throw error;
  });
  child.on('close', (code) => {
    clearTimeout(deadline);
    if (!nativeSmokeSucceeded(code, timedOut, output)) {
      console.error(
        'Native smoke lacked a successful IPC completion handshake',
      );
      process.exitCode = 1;
    } else {
      const report = {
        platform: process.platform,
        embeddedWebView: true,
        renderedShell: true,
        styledShell: true,
        runtimeStyleNonce: true,
        versionedIpc: true,
        typedAppInfo: true,
        eventSubscription: true,
        u64Precision: true,
        malformedInputRejected: true,
        invalidVersionRejected: true,
      };
      mkdirSync(resolve(root, 'artifacts/native'), { recursive: true });
      writeFileSync(
        resolve(root, 'artifacts/native/smoke.json'),
        `${JSON.stringify(report, null, 2)}\n`,
      );
      console.log('Native embedded WebView shell + versioned IPC smoke passed');
    }
  });
} else if (action === 'launch') {
  const child = spawn(resolve(root, 'target/debug/stellar-desktop.exe'), [], {
    cwd: root,
    stdio: 'inherit',
  });
  child.on('error', (error) => {
    throw error;
  });
  child.on('exit', (code) => {
    process.exitCode = code ?? 1;
  });
} else {
  if (!args[action]) throw new Error(`Unknown native action: ${action}`);
  if (action === 'contract-check') {
    const { verifyBindings } = await import('./contracts.mjs');
    verifyBindings((variant) =>
      cargo(
        [
          ...args[action],
          ...(variant ? ['--features', 'contract-variant-fixture'] : []),
        ],
        true,
      ),
    );
  }
  const text =
    action === 'contract-check'
      ? ''
      : cargo(args[action], action.startsWith('contract-'));
  if (action.startsWith('contract-')) {
    const file = resolve(root, 'libs/desktop-contracts/src/generated.ts');
    if (action === 'contract-generate') writeFileSync(file, text);
    else if (
      action !== 'contract-check' &&
      readFileSync(file, 'utf8').replaceAll('\r\n', '\n') !==
        text.replaceAll('\r\n', '\n')
    )
      throw new Error(
        'Rust bindings drifted; run node tools/native/cargo.mjs contract-generate',
      );
  }
}
