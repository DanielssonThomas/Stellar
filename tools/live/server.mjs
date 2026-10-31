import http from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { collectSnapshot } from './telemetry.mjs';

const origins = new Set(['http://127.0.0.1:4200', 'http://localhost:4200']);
const maxSseQueuedBytes = 128 * 1024;
const drainTimeoutMs = 2000;
const pendingDrains = new WeakMap();

function disconnectClient(client, clients) {
  const timer = pendingDrains.get(client);
  if (timer) clearTimeout(timer);
  pendingDrains.delete(client);
  clients.delete(client);
  client.destroy();
}

export function sendSsePacket(client, packet, clients) {
  const bytes = Buffer.byteLength(packet, 'utf8');
  if (
    pendingDrains.has(client) ||
    bytes > maxSseQueuedBytes ||
    (client.writableLength ?? 0) + bytes > maxSseQueuedBytes
  ) {
    disconnectClient(client, clients);
    return false;
  }
  try {
    if (client.write(packet)) return true;
    const timer = setTimeout(
      () => disconnectClient(client, clients),
      drainTimeoutMs,
    );
    timer.unref();
    pendingDrains.set(client, timer);
    client.once('drain', () => {
      if (pendingDrains.get(client) !== timer) return;
      clearTimeout(timer);
      pendingDrains.delete(client);
    });
    return true;
  } catch {
    // A disconnected reader must not interrupt healthy clients.
  }
  disconnectClient(client, clients);
  return false;
}

export function createLiveServer(collect = collectSnapshot, intervalMs = 2000) {
  const clients = new Set();
  let sequence = 0;
  let lastComparable = '';
  let latest = collect();
  const server = http.createServer((request, response) => {
    const port = server.address()?.port;
    const host = request.headers.host?.toLowerCase();
    const origin = request.headers.origin;
    const cors = origins.has(origin)
      ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }
      : {};
    if (
      ![`127.0.0.1:${port}`, `localhost:${port}`].includes(host) ||
      (origin !== undefined && !origins.has(origin))
    ) {
      response.writeHead(403, { 'Cache-Control': 'no-store' });
      response.end();
      return;
    }
    if (
      request.method !== 'GET' ||
      !['/api/live', '/api/live/events'].includes(request.url)
    ) {
      response.writeHead(404, { ...cors, 'Cache-Control': 'no-store' });
      response.end();
      return;
    }
    if (request.url === '/api/live') {
      response.writeHead(200, {
        ...cors,
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(JSON.stringify({ sequence, ...latest }));
      return;
    }
    if (clients.size >= 16) {
      response.writeHead(503, cors);
      response.end();
      return;
    }
    response.writeHead(200, {
      ...cors,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Content-Type-Options': 'nosniff',
    });
    clients.add(response);
    request.on('close', () => clients.delete(response));
    sendSsePacket(
      response,
      `event: snapshot\nid: ${sequence}\ndata: ${JSON.stringify({ sequence, ...latest })}\n\n`,
      clients,
    );
  });
  const timer = setInterval(() => {
    try {
      latest = collect();
      const comparable = JSON.stringify(
        latest.agents.map((agent) => {
          const copy = { ...agent };
          delete copy.source;
          return copy;
        }),
      );
      if (comparable !== lastComparable) {
        lastComparable = comparable;
        sequence += 1;
        const packet = `event: snapshot\nid: ${sequence}\ndata: ${JSON.stringify({ sequence, ...latest })}\n\n`;
        for (const client of clients) sendSsePacket(client, packet, clients);
      } else
        for (const client of clients)
          sendSsePacket(client, ': heartbeat\n\n', clients);
    } catch {
      latest = {
        schemaVersion: 1,
        observedAt: new Date().toISOString(),
        agents: latest.agents.map((agent) => ({
          ...agent,
          state: 'disconnected',
          activity: null,
          tool: null,
          source: { ...agent.source, health: 'unavailable' },
        })),
      };
      sequence += 1;
      const packet = `event: snapshot\nid: ${sequence}\ndata: ${JSON.stringify({ sequence, ...latest })}\n\n`;
      for (const client of clients) sendSsePacket(client, packet, clients);
    }
  }, intervalMs);
  timer.unref();
  server.on('close', () => {
    clearInterval(timer);
    for (const client of clients) client.end();
  });
  return server;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  createLiveServer().listen(4212, '127.0.0.1', () =>
    process.stdout.write(
      'Stellar Live telemetry: http://127.0.0.1:4212/api/live\n',
    ),
  );
}
