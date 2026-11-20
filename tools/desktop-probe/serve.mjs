import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
};
createServer(async (request, response) => {
  const name = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  const target = path.resolve(root, `.${name === '/' ? '/index.html' : name}`);
  if (request.method !== 'GET' || !target.startsWith(`${root}${path.sep}`)) {
    response.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(target);
    response.writeHead(200, {
      'Content-Type': types[path.extname(target)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
}).listen(1425, '127.0.0.1', () =>
  console.log('Probe assets: http://127.0.0.1:1425'),
);
