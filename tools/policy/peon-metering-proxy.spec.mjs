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
    requestRecords: [
      {
        request: 1,
        decision: 'upstream-failed',
        promptTokens: 2,
        remainingTokens: 20,
        completionTokens: null,
        chargedOutputTokens: 8,
        emittedToolCalls: 0,
        messageContentTokensByRole: { user: 2 },
        toolSchemaContentTokens: 0,
        toolOutputMessages: 0,
      },
    ],
  });
});

test('records exact tokenized prompt size when cumulative budget denies before inference', async (t) => {
  let modelRequests = 0;
  const meter = await withProxy(t, {
    maxModelTokens: 10,
    maxToolCalls: 2,
    initialModelTokens: 8,
    fetchImpl: async (url) => {
      if (String(url).endsWith('/apply-template'))
        return json({ prompt: 'rendered sensitive prompt text' });
      if (String(url).endsWith('/tokenize')) return json({ tokens: [1, 2] });
      modelRequests += 1;
      return json({
        choices: [{ message: { role: 'assistant', content: 'unexpected' } }],
        usage: { prompt_tokens: 2, completion_tokens: 1 },
      });
    },
  });

  const denied = await request(meter.url, { max_tokens: 4 });
  assert.equal(denied.status, 429);
  assert.equal(modelRequests, 0);
  assert.deepEqual(meter.snapshot().requestRecords, [
    {
      request: 1,
      decision: 'denied-budget',
      promptTokens: 2,
      remainingTokens: 2,
      completionTokens: null,
      chargedOutputTokens: 0,
      emittedToolCalls: 0,
      messageContentTokensByRole: { user: 2 },
      toolSchemaContentTokens: 0,
      toolOutputMessages: 0,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(meter.snapshot()), /sensitive prompt/);
});

test('records model-emitted calls separately as numeric output metadata', async (t) => {
  const meter = await withProxy(t, {
    maxModelTokens: 20,
    maxToolCalls: 4,
    fetchImpl: async (url) => {
      if (String(url).endsWith('/apply-template'))
        return json({ prompt: 'rendered' });
      if (String(url).endsWith('/tokenize')) return json({ tokens: [1, 2] });
      return json({
        choices: [
          {
            message: {
              role: 'assistant',
              tool_calls: [
                {
                  id: 'call-a',
                  type: 'function',
                  function: { name: 'read_file' },
                },
                {
                  id: 'call-b',
                  type: 'function',
                  function: { name: 'search_files' },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 2, completion_tokens: 3 },
      });
    },
  });

  assert.equal((await request(meter.url, { max_tokens: 8 })).status, 200);
  assert.deepEqual(meter.snapshot().requestRecords[0], {
    request: 1,
    decision: 'forwarded',
    promptTokens: 2,
    remainingTokens: 20,
    completionTokens: 3,
    chargedOutputTokens: 3,
    emittedToolCalls: 2,
    messageContentTokensByRole: { user: 2 },
    toolSchemaContentTokens: 0,
    toolOutputMessages: 0,
  });
  assert.doesNotMatch(JSON.stringify(meter.snapshot()), /call-a|read_file/);
});

test('measures message roles, tool schemas, and returned tool outputs without retaining text', async (t) => {
  const meter = await withProxy(t, {
    maxModelTokens: 20,
    maxToolCalls: 4,
    fetchImpl: async (url) => {
      if (String(url).endsWith('/apply-template'))
        return json({ prompt: 'formatted private conversation' });
      if (String(url).endsWith('/tokenize')) return json({ tokens: [1, 2, 3] });
      return json({
        choices: [{ message: { role: 'assistant', content: 'done' } }],
        usage: { prompt_tokens: 12, completion_tokens: 1 },
      });
    },
  });

  const result = await fetch(`${meter.url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: 'private repository instructions' },
        { role: 'user', content: 'private task details' },
        {
          role: 'tool',
          tool_call_id: 'private-call-id',
          content: 'private tool output',
        },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'private_tool_name',
            parameters: { type: 'object' },
          },
        },
      ],
      max_tokens: 4,
    }),
  });
  assert.equal(result.status, 200);
  const record = meter.snapshot().requestRecords[0];
  assert.deepEqual(record.messageContentTokensByRole, {
    system: 3,
    user: 3,
    tool: 3,
  });
  assert.equal(record.toolSchemaContentTokens, 3);
  assert.equal(record.toolOutputMessages, 1);
  assert.doesNotMatch(
    JSON.stringify(meter.snapshot()),
    /private repository instructions|private task details|private tool output|private_tool_name/,
  );
});

test('keeps only a bounded window of numeric request records', async (t) => {
  const meter = await withProxy(t, {
    maxModelTokens: 1_000,
    maxToolCalls: 64,
    fetchImpl: async (url) => {
      if (String(url).endsWith('/apply-template'))
        return json({ prompt: 'rendered' });
      if (String(url).endsWith('/tokenize')) return json({ tokens: [1, 2] });
      return json({
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
        usage: { prompt_tokens: 2, completion_tokens: 1 },
      });
    },
  });

  for (let index = 0; index < 34; index += 1)
    assert.equal((await request(meter.url, { max_tokens: 2 })).status, 200);
  const records = meter.snapshot().requestRecords;
  assert.equal(records.length, 32);
  assert.equal(records[0].request, 3);
  assert.equal(records[31].request, 34);
});

test('counts streamed tool calls before releasing the completed stream', async (t) => {
  let modelRequests = 0;
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
      modelRequests += 1;
      return new Response(events, {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });

  const response = await request(meter.url, { stream: true, max_tokens: 8 });
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error, 'Tool call budget exhausted.');
  assert.equal(meter.snapshot().toolCalls, 2);
  assert.equal(meter.snapshot().requestRecords[0].emittedToolCalls, 2);
  assert.equal(meter.snapshot().requestRecords[0].decision, 'forwarded');

  const retry = await request(meter.url, { stream: true, max_tokens: 8 });
  assert.equal(retry.status, 429);
  assert.equal(modelRequests, 1);
  assert.equal(meter.snapshot().requests, 2);
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
  }).catch(() => undefined);
  await started;
  controller.abort();
  await pending;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(meter.snapshot().modelTokens, 10);
  assert.equal(meter.snapshot().cancellations, 1);
});
