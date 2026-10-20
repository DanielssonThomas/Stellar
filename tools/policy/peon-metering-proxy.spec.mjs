import assert from 'node:assert/strict';
import test from 'node:test';
import { connect } from 'node:net';
import { createPeonMeteringProxy } from './peon-metering-proxy.mjs';

const json = (value, status = 200, headers = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

async function withProxy(t, options) {
  const meter = createPeonMeteringProxy(options);
  await new Promise((resolve) => meter.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await Promise.all([
      new Promise((resolve) => meter.server.close(resolve)),
      new Promise((resolve) => meter.egressServer.close(resolve)),
      new Promise((resolve) => meter.usageServer.close(resolve)),
    ]);
  });
  await new Promise((resolve) =>
    meter.egressServer.listen(0, '127.0.0.1', resolve),
  );
  await new Promise((resolve) =>
    meter.usageServer.listen(0, '127.0.0.1', resolve),
  );
  const address = meter.server.address();
  const egressAddress = meter.egressServer.address();
  return {
    ...meter,
    url: `http://127.0.0.1:${address.port}`,
    egressPort: egressAddress.port,
    usagePort: meter.usageServer.address().port,
  };
}

const request = (url, body) =>
  fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: 'small prompt' }],
      ...body,
    }),
  });

test('reserves per-request generation and enforces the cumulative token budget', async (t) => {
  const forwarded = [];
  const meter = await withProxy(t, {
    maxModelTokens: 10,
    maxToolCalls: 4,
    fetchImpl: async (url, init) => {
      if (String(url).endsWith('/apply-template'))
        return json({ prompt: 'rendered' });
      if (String(url).endsWith('/tokenize')) return json({ tokens: [1, 2] });
      const body = JSON.parse(init.body);
      forwarded.push(body.max_tokens);
      return json({
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
        usage: { prompt_tokens: 2, completion_tokens: 3 },
      });
    },
  });

  assert.equal((await request(meter.url, { max_tokens: 20 })).status, 200);
  assert.equal((await request(meter.url, { max_tokens: 20 })).status, 200);
  assert.equal((await request(meter.url, { max_tokens: 1 })).status, 429);
  assert.deepEqual(forwarded, [8, 3]);
  assert.equal(meter.snapshot().modelTokens, 10);
  const usageResponse = await fetch(
    `http://127.0.0.1:${meter.usagePort}/usage`,
  );
  assert.equal((await usageResponse.json()).modelTokens, 10);
});

test('denies non-allowlisted outbound HTTPS endpoints', async (t) => {
  const meter = await withProxy(t, { fetchImpl: fetch });
  const result = await new Promise((resolve, reject) => {
    const socket = connect(meter.egressPort, '127.0.0.1', () =>
      socket.write(
        'CONNECT model.example:443 HTTP/1.1\r\nHost: model.example:443\r\n\r\n',
      ),
    );
    let response = '';
    socket.on('data', (chunk) => {
      response += chunk.toString();
    });
    socket.on('end', () => resolve(response));
    socket.on('error', reject);
  });
  assert.match(result, /^HTTP\/1\.1 403 Forbidden/);
});

test('charges prompt and maximum requested output tokens on upstream failures', async (t) => {
  const meter = await withProxy(t, {
    maxModelTokens: 20,
    maxToolCalls: 4,
    fetchImpl: async (url) => {
      if (String(url).endsWith('/apply-template'))
        return json({ prompt: 'rendered' });
      if (String(url).endsWith('/tokenize')) return json({ tokens: [1, 2] });
      return json({ error: 'upstream failure' }, 503);
    },
  });

  assert.equal((await request(meter.url, { max_tokens: 8 })).status, 503);
  assert.deepEqual(meter.snapshot(), {
    modelTokens: 10,
    toolCalls: 0,
    exceededResource: null,
    requests: 1,
    failures: 1,
    cancellations: 0,
  });
});

test('counts streamed tool calls before releasing the completed stream', async (t) => {
  const events =
    [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1' }] } }] },
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '{}' } }],
            },
          },
        ],
      },
      { choices: [{ delta: { tool_calls: [{ index: 1, id: 'call-2' }] } }] },
      { choices: [], usage: { prompt_tokens: 2, completion_tokens: 4 } },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join('') + 'data: [DONE]\n\n';
  const meter = await withProxy(t, {
    maxModelTokens: 20,
    maxToolCalls: 1,
    fetchImpl: async (url) => {
      if (String(url).endsWith('/apply-template'))
        return json({ prompt: 'rendered' });
      if (String(url).endsWith('/tokenize')) return json({ tokens: [1, 2] });
      return new Response(events, {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });

  const response = await request(meter.url, { stream: true, max_tokens: 8 });
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error, 'Tool call budget exhausted.');
  assert.equal(meter.snapshot().toolCalls, 2);
});

test('charges the full output reservation when a generation is cancelled', async (t) => {
  let generationStarted;
  const started = new Promise((resolve) => {
    generationStarted = resolve;
  });
  const meter = await withProxy(t, {
    maxModelTokens: 10,
    maxToolCalls: 2,
    fetchImpl: async (url, init) => {
      if (String(url).endsWith('/apply-template'))
        return json({ prompt: 'rendered' });
      if (String(url).endsWith('/tokenize')) return json({ tokens: [1, 2] });
      generationStarted();
      return new Promise((_, reject) =>
        init.signal.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        ),
      );
    },
  });
  const controller = new AbortController();
  const pending = fetch(`${meter.url}/v1/chat/completions`, {
    method: 'POST',
    signal: controller.signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: 'small prompt' }],
      max_tokens: 8,
    }),
  }).catch(() => {});
  await started;
  controller.abort();
  await pending;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(meter.snapshot().modelTokens, 10);
  assert.equal(meter.snapshot().cancellations, 1);
});
