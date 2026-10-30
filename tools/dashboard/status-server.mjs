import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSnapshot } from './status-adapter.mjs';

const allowedOrigins = new Set([
  'http://127.0.0.1:4200',
  'http://localhost:4200',
]);

export function createStatusServer(snapshot = buildSnapshot) {
  return http.createServer(async (request, response) => {
    const origin = request.headers.origin;
    const cors = allowedOrigins.has(origin)
      ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }
      : {};
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
