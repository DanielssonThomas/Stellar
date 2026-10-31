import http from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSnapshot } from './status-adapter.mjs';

const allowedOrigins = new Set([
  'http://127.0.0.1:4200',
  'http://localhost:4200',
]);

async function characterImage(kind) {
  const root =
    process.env.STELLAR_DESIGN_ROOT || 'D:\\ai-repositories\\Stellar-Design';
  const relative =
    kind === 'reference'
      ? 'art-direction/assistant/references/professional_reference.png'
      : (
          await readFile(
            path.join(
              root,
              'characters/stellar-assistant/phase1-progress.json',
            ),
            'utf8',
          ).then(JSON.parse)
        ).latest_review_comparison;
  if (
    kind === 'latest' &&
    (typeof relative !== 'string' ||
      !/^assets\/characters\/stellar-assistant-phase1\/[a-zA-Z0-9/_+.-]+\.png$/.test(
        relative,
      ))
  )
    throw new Error('No allowlisted character image');
  const actualRoot = await realpath(root);
  const actualFile = await realpath(path.join(root, relative));
  if (!actualFile.startsWith(`${actualRoot}${path.sep}`))
    throw new Error('Image outside design root');
  if ((await stat(actualFile)).size > 5_000_000)
    throw new Error('Image too large');
  return readFile(actualFile);
}

export function createStatusServer(snapshot = buildSnapshot) {
  return http.createServer(async (request, response) => {
    const origin = request.headers.origin;
    const cors = allowedOrigins.has(origin)
      ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }
      : {};
    const imageKind =
      request.url === '/api/character-image/reference'
        ? 'reference'
        : /^\/api\/character-image\/latest(?:\?revision=\d{13})?$/.test(
              request.url ?? '',
            )
          ? 'latest'
          : null;
    if (request.method === 'GET' && imageKind) {
      try {
        const image = await characterImage(imageKind);
        response.writeHead(200, {
          ...cors,
          'Content-Type': 'image/png',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        response.end(image);
      } catch {
        response.writeHead(404, { ...cors, 'Cache-Control': 'no-store' });
        response.end();
      }
      return;
    }
    if (request.method !== 'GET' || request.url !== '/api/status') {
      response.writeHead(404, {
        ...cors,
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end('{"error":"not found"}');
      return;
    }
    try {
      const body = JSON.stringify(await snapshot());
      response.writeHead(200, {
        ...cors,
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(body);
    } catch {
      response.writeHead(503, {
        ...cors,
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end('{"error":"status unavailable"}');
    }
  });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const port = Number(process.env.STELLAR_STATUS_PORT || 4211);
  createStatusServer().listen(port, '127.0.0.1', () => {
    process.stdout.write(
      `Stellar read-only status: http://127.0.0.1:${port}/api/status\n`,
    );
  });
}
