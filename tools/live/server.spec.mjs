import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLiveServer } from './server.mjs';

test('loopback server serves a bounded snapshot and rejects arbitrary routes', async () => {
  const server = createLiveServer(
    () => ({
      schemaVersion: 1,
      observedAt: '2026-10-31T00:00:00.000Z',
      agents: [],
    }),
    10_000,
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${base}/api/live`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).agents.length, 0);
    assert.equal((await fetch(`${base}/api/live?path=secret`)).status, 404);
    assert.equal(
      (await fetch(`${base}/api/live`, { method: 'POST' })).status,
      404,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('SSE follows a state change without a browser refresh', async () => {
  let state = 'unknown';
  const server = createLiveServer(
    () => ({
      schemaVersion: 1,
      observedAt: '2026-10-31T00:00:00.000Z',
      agents: [{ id: 'designer', state, source: { health: 'available' } }],
    }),
    20,
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const abort = new AbortController();
  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/live/events`,
      { signal: abort.signal },
    );
    assert.equal(
      response.headers.get('content-type'),
      'text/event-stream; charset=utf-8',
    );
    const reader = response.body.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.match(first, /"state":"unknown"/);
    state = 'running';
    const next = await Promise.race([
      reader.read(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('SSE timeout')), 1000),
      ),
    ]);
    assert.match(new TextDecoder().decode(next.value), /"state":"running"/);
  } finally {
    abort.abort();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
