/** Explicit isolated native test build. --build never launches an application. */
import { spawn, spawnSync } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const action = process.argv[2];
if (process.argv.length !== 3 || !['--build', '--run'].includes(action))
  throw new Error('Expected --build or --run');
const root = resolve(import.meta.dirname, '../..');
const target = resolve(root, 'target/recognition-smoke');
const base = JSON.parse(
  await readFile(
    resolve(root, 'apps/stellar-desktop/src-tauri/tauri.conf.json'),
    'utf8',
  ),
);
export const permissions = [
  'allow-shell-status',
  'allow-app-info',
  'allow-telemetry-snapshot',
  'core:event:allow-listen',
  'core:event:allow-unlisten',
  'allow-speech-snapshot',
  'allow-speech-keywords',
  'allow-speech-transcribe',
  'allow-speech-stop',
  'allow-recognition-result',
];
const env = {
  ...process.env,
  CARGO_TARGET_DIR: target,
  TAURI_CONFIG: JSON.stringify({
    app: {
      windows: base.app.windows.map((window) => ({ ...window, create: false })),
      security: {
        capabilities: [
          {
            identifier: 'recognition-smoke',
            windows: ['main'],
            permissions,
          },
        ],
      },
    },
  }),
};
// Never inherit debugging flags from another diagnostic environment.
for (const key of [
  'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS',
  'WEBVIEW2_PIPE_FOR_SCRIPT_DEBUGGER',
  'WEBVIEW2_WAIT_FOR_SCRIPT_DEBUGGER',
])
  delete env[key];
if (action === '--build') {
  const built = spawnSync(
    'cargo',
    [
      'build',
      '--locked',
      '-p',
      'stellar-desktop',
      '--features',
      'custom-protocol,recognition-smoke',
    ],
    { cwd: root, env, windowsHide: true, stdio: 'inherit' },
  );
  if (built.error) throw built.error;
  process.exitCode = built.status ?? 1;
} else {
  if (process.platform !== 'win32')
    throw new Error('Windows WebView2 required');
  const artifact = resolve(root, 'artifacts/native');
  await mkdir(artifact, { recursive: true });
  const receiptDirectory = resolve(
    artifact,
    `recognition-webview-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}`,
  );
  await mkdir(receiptDirectory);
  const fixture = JSON.parse(
    await readFile(resolve(artifact, 'recognition-probe-input.json'), 'utf8'),
  );
  for (const name of ['wake', 'long'])
    if (
      !Array.isArray(fixture[name]) ||
      fixture[name].length < 1 ||
      fixture[name].length > 320000 ||
      fixture[name].some((x) => !Number.isInteger(x) || x < -32768 || x > 32767)
    )
      throw new Error('Invalid synthetic fixture');
  const child = spawn(resolve(target, 'debug/stellar-desktop.exe'), [], {
    cwd: root,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '',
    failed = false;
  const kill = () => {
    if (child.exitCode === null && child.pid)
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
  };
  const deadline = setTimeout(() => {
    failed = true;
    kill();
  }, 90000);
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => {
      if (output.length + chunk.length > 65536) {
        failed = true;
        kill();
      } else output += chunk.toString();
    });
  child.once('error', () => {
    failed = true;
  });
  const monitor = spawn(
    'D:/Hermes/profiles/ivy/recognition/.venv/Scripts/python.exe',
    [
      '-I',
      resolve(import.meta.dirname, 'recognition-resources.py'),
      '--pid',
      String(child.pid),
      '--output',
      resolve(receiptDirectory, 'resources.json'),
    ],
    { cwd: root, windowsHide: true, stdio: 'ignore' },
  );
  const code = await new Promise((resolve) => child.once('close', resolve));
  clearTimeout(deadline);
  if (monitor.exitCode === null)
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        monitor.kill();
        resolve();
      }, 3000);
      monitor.once('close', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  const line = output
    .split(/\r?\n/)
    .find((line) => line.startsWith('STELLAR_RECOGNITION_SMOKE '));
  const report = line
    ? JSON.parse(line.slice('STELLAR_RECOGNITION_SMOKE '.length))
    : null;
  await writeFile(
    resolve(receiptDirectory, 'result.json'),
    JSON.stringify(
      {
        scope:
          'Restricted native WebView; fixed synthetic PCM; no microphone, playback or Ivy submission',
        debugger: false,
        exitCode: code,
        failed,
        report,
      },
      null,
      2,
    ),
  );
  if (failed || code !== 0 || report?.success !== true)
    throw new Error(
      'Recognition WebView qualification failed; inspect bounded receipt',
    );
  console.log(JSON.stringify({ passed: true, receiptDirectory }));
}
