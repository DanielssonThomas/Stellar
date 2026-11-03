/** Explicit local fixture collection with the application's existing capture implementation. */
import { createServer } from 'node:http';
import {
  mkdir,
  readFile,
  writeFile,
  readdir,
  realpath,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, relative, isAbsolute, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { validRecording } from './live-recognition-core.mjs';

if (
  process.argv[2] !== '--collect-calibration' ||
  ![3, 5, 7].includes(process.argv.length)
)
  throw new Error(
    'Expected --collect-calibration; capture starts only from the local page.',
  );
const options = {};
for (let i = 3; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  if (!['--port', '--resume'].includes(key) || key in options)
    throw new Error('Invalid options');
  options[key] = process.argv[i + 1];
}
const port = options['--port'] === undefined ? 0 : Number(options['--port']);
if (!Number.isInteger(port) || port < 0 || port > 65535)
  throw new Error('Invalid loopback port');
const root = resolve(import.meta.dirname, '../..');
const artifactRoot = resolve(root, 'artifacts/native');
await mkdir(artifactRoot, { recursive: true });
const directory = options['--resume']
  ? await realpath(resolve(root, options['--resume']))
  : resolve(
      artifactRoot,
      `live-calibration-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    );
const inside = relative(await realpath(artifactRoot), directory);
if (
  inside.startsWith('..') ||
  isAbsolute(inside) ||
  !basename(directory).startsWith('live-calibration-')
)
  throw new Error(
    'Resume must name an existing calibration folder inside this worktree artifacts/native.',
  );
await mkdir(directory, { recursive: true });
const require = createRequire(import.meta.url);
const angularRequire = createRequire(
  require.resolve('@angular/build/package.json'),
);
const { build } = angularRequire('esbuild');
const bundle = await build({
  entryPoints: [resolve(import.meta.dirname, 'live-recognition.ts')],
  bundle: true,
  write: false,
  format: 'esm',
  target: 'es2022',
});
const token = randomBytes(32).toString('hex');
const trials = [
  ['wake', 'Ivy', 'Say Ivy alone in your normal voice.', 'ivy', 'passive'],
  [
    'wake-request',
    'Ivy, open my browser.',
    'Say this as one natural phrase.',
    'ivy',
    'passive',
  ],
  ['done', 'Done.', 'Normal speed.', 'done', 'listening'],
  ['im-done', 'I’m done.', 'Normal speed.', 'done', 'listening'],
  ['prompt', 'Prompt.', 'Normal speed.', 'prompt', 'listening'],
  ['clear', 'Clear.', 'Normal speed.', 'clear', 'listening'],
  [
    'cancel',
    'Prompt cancel.',
    'Imagine a prompt is currently being composed.',
    'prompt cancel',
    'composing',
  ],
  ['reset', 'New session.', 'Normal speed.', 'new session', 'listening'],
  [
    'reload',
    'Reload MCP.',
    'Use your normal pronunciation of the letters.',
    'reload mcp',
    'listening',
  ],
  [
    'done-fast',
    'Done.',
    'Quick but natural; avoid exaggerated pronunciation.',
    'done',
    'listening',
  ],
  [
    'im-done-soft',
    'I’m done.',
    'Comfortable quiet voice at your usual microphone distance.',
    'done',
    'listening',
  ],
  ['prompt-fast', 'Prompt.', 'Quick but natural.', 'prompt', 'listening'],
  [
    'embedded',
    'Please clear the table after dinner.',
    'One normal sentence; this must not clear Ivy.',
    null,
    'listening',
  ],
  [
    'pause',
    'Clear skies are expected tomorrow.',
    'Leave a natural thinking pause after “clear”, then finish the sentence.',
    null,
    'listening',
  ],
  [
    'near-done',
    'I’m down by the door.',
    'Normal sentence, not a command.',
    null,
    'listening',
  ],
  [
    'near-wake',
    'I mean, I think the other option is better.',
    'Normal sentence, without saying Ivy.',
    null,
    'passive',
  ],
  [
    'dictation',
    'Explain what you did today for about twenty seconds.',
    'Speak naturally with quiet pauses. Avoid private information.',
    null,
    'listening',
  ],
  [
    'background',
    'Background media or room conversation only.',
    'If convenient, play ordinary speech/media for 20 seconds; do not say a command yourself.',
    null,
    'passive',
  ],
].map(([id, text, instruction, expected, mode]) => ({
  id,
  text,
  instruction,
  expected,
  mode,
}));
const manifest = {
  fixtureKind:
    process.env.STELLAR_RECORDER_SELF_TEST === '1'
      ? 'synthetic'
      : 'recorded-human',
  purpose: 'calibration-not-holdout',
  sampleRateHz: 16000,
  source:
    'Unmodified Stellar AudioActivityController and WebAudioSource; Chrome fixture collection, not native WebView qualification',
  trials,
};
if (options['--resume']) {
  const previous = JSON.parse(
    await readFile(resolve(directory, 'manifest.json'), 'utf8'),
  );
  if (JSON.stringify(previous) !== JSON.stringify(manifest))
    throw new Error(
      'Calibration manifest changed; preserved existing session.',
    );
} else
  await writeFile(
    resolve(directory, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
    { flag: 'wx' },
  );
let origin;
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Ivy microphone calibration</title><style>body{max-width:840px;margin:40px auto;padding:20px;font:18px system-ui;background:#14151b;color:#f4f4fa}button,select{font:inherit;padding:10px;margin:6px}h2{font-size:36px}#status{padding:12px;border:1px solid #9092a8}button:disabled{opacity:.5}</style><h1>Ivy microphone calibration</h1><p>Local recordings only. Stop Stellar's microphone before enabling this page. Use your normal Ivy microphone. No assistant commands or requests are submitted.</p><p>If permission interrupts capture, allow it, then Enable again. Stop, refresh inputs and choose your usual microphone if needed.</p><select id="input" aria-label="Microphone"></select><button id="refresh">Refresh inputs</button><button id="enable">Enable microphone</button><button id="stop">Stop microphone</button><p id="status">Microphone stopped</p><p id="feedback" role="status"></p><p id="progress"></p><h2 id="prompt"></h2><p id="instruction"></p><button id="record" disabled>Record this item</button><button id="finish" disabled>Save recording</button><button id="next" disabled>Next item</button><p>Press Record, say the displayed item, leave one second of quiet, then Save. Recordings stop at 45 seconds. Focus loss releases capture; an interrupted item must be repeated. Device names and identifiers are not saved. Raw audio stays in a private ignored artifact folder on this computer.</p><script type="module" src="/client.js"></script></html>`;
const server = createServer(async (request, response) => {
  const reply = (status, body, type = 'text/plain') => {
    response.writeHead(status, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy':
        "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; worker-src 'self'",
    });
    response.end(body);
  };
  try {
    if (!origin || request.headers.host !== new URL(origin).host)
      return reply(403, 'Forbidden');
    if (request.method === 'GET' && request.url === '/')
      return reply(200, html, 'text/html; charset=utf-8');
    if (request.method === 'GET' && request.url === '/client.js')
      return reply(200, bundle.outputFiles[0].contents, 'text/javascript');
    if (request.method === 'GET' && request.url === '/session') {
      const files = await readdir(directory);
      return reply(
        200,
        JSON.stringify({
          token,
          trials,
          completed: trials.flatMap((trial, index) =>
            files.includes(trial.id + '.wav') ? [index] : [],
          ),
        }),
        'application/json',
      );
    }
    if (
      request.method === 'GET' &&
      [
        '/audio-worklets/stellar-pcm-worklet.js',
        '/audio-worklets/pcm-resampler.js',
      ].includes(request.url)
    )
      return reply(
        200,
        await readFile(
          resolve(
            root,
            'libs/services/audio-activity/worklet',
            request.url.split('/').at(-1),
          ),
        ),
        'text/javascript',
      );
    const match = /^\/trial\/(\d{1,2})$/.exec(request.url ?? '');
    if (request.method !== 'POST' || !match) return reply(404, 'Not found');
    const index = Number(match[1]),
      length = Number(request.headers['content-length']);
    if (
      !trials[index] ||
      request.headers.origin !== origin ||
      request.headers['x-qualification-token'] !== token ||
      request.headers['content-type'] !== 'audio/wav'
    )
      return reply(403, 'Forbidden');
    if (!Number.isInteger(length) || length < 6444 || length > 1440044)
      return reply(413, 'Invalid length');
    const buffers = [];
    let total = 0;
    for await (const buffer of request) {
      total += buffer.length;
      if (total > length) return reply(413, 'Invalid length');
      buffers.push(buffer);
    }
    const wav = Buffer.concat(buffers);
    if (total !== length || !validRecording(wav))
      return reply(400, 'Invalid WAV');
    await writeFile(resolve(directory, trials[index].id + '.wav'), wav, {
      flag: 'wx',
    });
    console.log(
      `Saved item ${index + 1}/${trials.length}; ${(length - 44) / 32000} seconds`,
    );
    return reply(201, 'Saved');
  } catch (error) {
    return reply(error?.code === 'EEXIST' ? 409 : 500, 'Collection failed');
  }
});
server.requestTimeout = 15000;
server.headersTimeout = 5000;
await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
origin = `http://127.0.0.1:${server.address().port}`;
console.log(
  JSON.stringify({
    url: origin,
    privateOutput: directory,
    scope: manifest.source,
  }),
);
process.on('SIGINT', () => server.close());
setTimeout(() => server.close(), 45 * 60 * 1000).unref();
