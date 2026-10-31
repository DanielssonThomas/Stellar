import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { createLiveServer, sendSsePacket } from './server.mjs';

test('a stalled SSE reader is removed without starving another client', () => {
  const writes = [];
  const stalled = {
    writableLength: 128 * 1024 - 1,
    destroyed: false,
    write: () => {
      throw new Error('stalled reader must not be written');
    },
    destroy() {
      this.destroyed = true;
    },
  };
  const healthy = {
    writableLength: 0,
    destroyed: false,
    write(packet) {
      writes.push(packet);
      return true;
    },
    destroy() {
      this.destroyed = true;
    },
  };
  const clients = new Set([stalled, healthy]);
  for (const client of clients)
    sendSsePacket(client, 'event: snapshot\ndata: updated\n\n', clients);
  assert.equal(stalled.destroyed, true);
  assert.equal(clients.has(stalled), false);
  assert.equal(healthy.destroyed, false);
  assert.deepEqual(writes, ['event: snapshot\ndata: updated\n\n']);

  const backpressured = {
    writableLength: 0,
    destroyed: false,
    write: () => false,
    once(event, handler) {
      this.drain = handler;
    },
    destroy() {
      this.destroyed = true;
    },
  };
  clients.add(backpressured);
  assert.equal(sendSsePacket(backpressured, ': heartbeat\n\n', clients), true);
  assert.equal(clients.has(backpressured), true);
  assert.equal(sendSsePacket(backpressured, ': heartbeat\n\n', clients), false);
  assert.equal(backpressured.destroyed, true);
  assert.equal(clients.has(backpressured), false);

  const draining = {
    writableLength: 0,
    destroyed: false,
    write: () => false,
    once(event, handler) {
      this.drain = handler;
    },
    destroy() {
      this.destroyed = true;
    },
  };
  clients.add(draining);
  assert.equal(sendSsePacket(draining, ': heartbeat\n\n', clients), true);
  draining.drain();
  assert.equal(sendSsePacket(draining, ': heartbeat\n\n', clients), true);
  assert.equal(draining.destroyed, false);
});

test('an actively reading SSE client receives a full snapshot above the write threshold', async () => {
  const server = createLiveServer(
    () => ({
      schemaVersion: 1,
      observedAt: '2026-10-31T00:00:00.000Z',
      agents: Array.from({ length: 9 }, (_, index) => ({
        id: `agent-${index}`,
        state: 'running',
        history: Array.from({ length: 40 }, (_, event) => ({
          id: `${index}-${event}`,
          text: 'normal activity '.repeat(5),
        })),
      })),
    }),
    10_000,
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const abort = new AbortController();
  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/live/events`,
      { signal: abort.signal },
    );
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const packet = await Promise.race([
      (async () => {
        let received = '';
        while (!received.endsWith('\n\n')) {
          const part = await reader.read();
          assert.equal(part.done, false);
          received += new TextDecoder().decode(part.value);
        }
        return received;
      })(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('large SSE snapshot timeout')), 1000),
      ),
    ]);
    assert.ok(Buffer.byteLength(packet) > 16 * 1024);
    assert.match(packet, /"id":"8-39"/);
  } finally {
    abort.abort();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

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
    assert.equal(
      await new Promise((resolve, reject) =>
        http
          .get(
            `${base}/api/live`,
            { headers: { Host: `untrusted.example:${server.address().port}` } },
            (res) => {
              res.resume();
              resolve(res.statusCode);
            },
          )
          .on('error', reject),
      ),
      403,
    );
    assert.equal(
      (
        await fetch(`${base}/api/live`, {
          headers: { Origin: 'http://untrusted.example:4200' },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${base}/api/live/events`, {
          headers: {
            Host: `untrusted.example:${server.address().port}`,
            Origin: 'http://untrusted.example:4200',
          },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${base}/api/live`, {
          headers: { Origin: 'http://localhost:4200' },
        })
      ).status,
      200,
    );
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

test('SSE recovers after a collector failure with unchanged agent data', async () => {
  let calls = 0;
  const server = createLiveServer(() => {
    calls += 1;
    if (calls === 3) throw new Error('temporary collector failure');
    return {
      schemaVersion: 1,
      observedAt: '2026-10-31T00:00:00.000Z',
      agents: [
        { id: 'designer', state: 'running', source: { health: 'available' } },
      ],
    };
  }, 20);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const abort = new AbortController();
  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/live/events`,
      { signal: abort.signal },
    );
    const reader = response.body.getReader();
    let buffer = '';
    const states = await Promise.race([
      (async () => {
        const result = [];
        while (result.length < 4) {
          const part = await reader.read();
          assert.equal(part.done, false);
          buffer += new TextDecoder().decode(part.value);
          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const packet = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const data = packet
              .split('\n')
              .find((line) => line.startsWith('data: '));
            if (data) result.push(JSON.parse(data.slice(6)).agents[0].state);
          }
        }
        return result;
      })(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('SSE recovery timeout')), 1000),
      ),
    ]);
    assert.deepEqual(states, ['running', 'running', 'disconnected', 'running']);
    const polling = await fetch(
      `http://127.0.0.1:${server.address().port}/api/live`,
    );
    assert.equal((await polling.json()).agents[0].state, 'running');
  } finally {
    abort.abort();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
