import assert from 'node:assert/strict';
import test from 'node:test';
import { connect } from 'node:net';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPeonMeteringProxy } from './peon-metering-proxy.mjs';
import {
  createPeonMeteringProxy as createEvidenceMeteringProxy,
  validSanitizedToolEvent,
} from './peon-metering-proxy-evidence.mjs';

const json = (value, status = 200, headers = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

async function withProxy(t, options, createMeter = createPeonMeteringProxy) {
  const meter = createMeter(options);
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

test('accepts only bounded content-free pre/post tool evidence', async (t) => {
  const meter = await withProxy(t, {}, createEvidenceMeteringProxy);
  const pre = {
    phase: 'pre',
    callId: 'a'.repeat(24),
    toolName: 'terminal',
    argumentBytes: 88,
    argumentCount: 1,
  };
  const post = {
    ...pre,
    phase: 'post',
    status: 'error',
    elapsedMs: 42,
    outputBytes: 120,
    exitCode: 1,
  };
  const send = (value) =>
    fetch(`http://127.0.0.1:${meter.usagePort}/tool-event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(value),
    });
  assert.equal(validSanitizedToolEvent(pre), true);
  assert.equal((await send(post)).status, 409);
  assert.equal((await send({ ...pre, command: 'secret=raw' })).status, 400);
  assert.equal((await send(pre)).status, 204);
  assert.equal((await send(post)).status, 204);
  assert.deepEqual(meter.snapshot().toolEvents, [pre, post]);
});

test('Hermes hook sanitizes secret arguments and raw output before transport', () => {
  const windowsPath = fileURLToPath(
    new URL('./record-peon-tool-event.py', import.meta.url),
  );
  const scriptPath =
    process.platform === 'win32'
      ? execFileSync(
          'wsl.exe',
          [
            '--distribution',
            'Ubuntu',
            '--user',
            'peon',
            '--exec',
            'wslpath',
            '-a',
            '-u',
            windowsPath,
          ],
          { encoding: 'utf8' },
        ).trim()
      : windowsPath;
  const code = [
    'import importlib.util,json,sys;sys.dont_write_bytecode=True',
    'spec=importlib.util.spec_from_file_location("hook",sys.argv[1])',
    'module=importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'print(json.dumps(module.sanitized_event(json.load(sys.stdin))))',
  ].join(';');
  const payload = {
    hook_event_name: 'post_tool_call',
    tool_name: 'terminal',
    tool_input: { command: 'echo secret=TOP_SECRET' },
    extra: {
      tool_call_id: 'call-1',
      status: 'error',
      duration_ms: 45,
      result: JSON.stringify({ exit_code: 1, output: 'TOP_SECRET' }),
    },
  };
  const args =
    process.platform === 'win32'
      ? [
          '--distribution',
          'Ubuntu',
          '--user',
          'peon',
          '--exec',
          'python3',
          '-c',
          code,
          scriptPath,
        ]
      : ['-c', code, scriptPath];
  const output = execFileSync(
    process.platform === 'win32' ? 'wsl.exe' : 'python3',
    args,
    {
      input: JSON.stringify(payload),
      encoding: 'utf8',
    },
  );
  assert.doesNotMatch(output, /TOP_SECRET|echo/);
  const event = JSON.parse(output);
  assert.deepEqual(
    { ...event, argumentBytes: 0, outputBytes: 0 },
    {
      phase: 'post',
      callId: createHash('sha256').update('call-1').digest('hex').slice(0, 24),
      toolName: 'terminal',
      argumentBytes: 0,
      argumentCount: 1,
      status: 'error',
      elapsedMs: 45,
      outputBytes: 0,
      exitCode: 1,
    },
  );
  assert.ok(event.argumentBytes > 0 && event.outputBytes > 0);
});

test('four-request meter denies a fifth request without forwarding it', async (t) => {
  let forwarded = 0;
  const meter = await withProxy(
    t,
    {
      maxModelTokens: 52_000,
      maxForwardedRequests: 4,
      fetchImpl: async (url) => {
        if (String(url).endsWith('/apply-template'))
          return json({ prompt: 'rendered' });
        if (String(url).endsWith('/tokenize')) return json({ tokens: [1, 2] });
        forwarded += 1;
        return json({
          choices: [{ message: { role: 'assistant', content: 'ok' } }],
          usage: { prompt_tokens: 2, completion_tokens: 1 },
        });
      },
    },
    createEvidenceMeteringProxy,
  );
  for (let index = 0; index < 4; index += 1)
    assert.equal((await request(meter.url, { max_tokens: 1 })).status, 200);
  assert.equal((await request(meter.url, { max_tokens: 1 })).status, 429);
  assert.equal(forwarded, 4);
  assert.equal(meter.snapshot().exceededResource, 'model-requests');
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
    forwardedRequests: 1,
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

test('enforces a trusted forwarded-request ceiling before the third upstream completion', async (t) => {
  let upstreamCompletions = 0;
  const meter = await withProxy(t, {
    maxForwardedRequests: 2,
    fetchImpl: async (url) => {
      if (String(url).endsWith('/apply-template'))
        return json({ prompt: 'rendered' });
      if (String(url).endsWith('/tokenize')) return json({ tokens: [1] });
      upstreamCompletions += 1;
      return json({
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    },
  });
  assert.equal((await request(meter.url, { max_tokens: 4 })).status, 200);
  assert.equal((await request(meter.url, { max_tokens: 4 })).status, 200);
  const denied = await request(meter.url, { max_tokens: 4 });
  assert.equal(denied.status, 429);
  assert.equal(upstreamCompletions, 2);
  assert.equal(meter.snapshot().forwardedRequests, 2);
  assert.equal(meter.snapshot().exceededResource, 'model-requests');
  assert.equal(
    meter.snapshot().requestRecords[2].decision,
    'denied-request-limit',
  );
});

test('removes the model-driven stage-transition API', async (t) => {
  const meter = await withProxy(t, { maxForwardedRequests: 2 });
  const response = await fetch(
    `http://127.0.0.1:${meter.usagePort}/stage/implement`,
    { method: 'POST' },
  );
  assert.equal(response.status, 404);
});

test('serializes concurrent requests at the request ceiling', async (t) => {
  let upstreamCompletions = 0;
  const meter = await withProxy(t, {
    maxForwardedRequests: 2,
    fetchImpl: async (url) => {
      if (String(url).endsWith('/apply-template'))
        return json({ prompt: 'rendered' });
      if (String(url).endsWith('/tokenize')) return json({ tokens: [1] });
      upstreamCompletions += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return json({
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    },
  });
  const responses = await Promise.all(
    Array.from({ length: 8 }, () => request(meter.url, { max_tokens: 4 })),
  );
  assert.equal(
    responses.filter((response) => response.status === 200).length,
    2,
  );
  assert.equal(
    responses.filter((response) => response.status === 429).length,
    6,
  );
  assert.equal(upstreamCompletions, 2);
  assert.equal(meter.snapshot().forwardedRequests, 2);
});

test('failed or cancelled forwarded requests consume capacity without resetting it', async (t) => {
  let completionCalls = 0;
  const failed = await withProxy(t, {
    maxForwardedRequests: 1,
    fetchImpl: async (url) => {
      if (String(url).endsWith('/apply-template'))
        return json({ prompt: 'rendered' });
      if (String(url).endsWith('/tokenize')) return json({ tokens: [1] });
      completionCalls += 1;
      return json({ error: 'unavailable' }, 503);
    },
  });
  assert.equal((await request(failed.url, { max_tokens: 4 })).status, 503);
  assert.equal((await request(failed.url, { max_tokens: 4 })).status, 429);
  assert.equal(completionCalls, 1);
  assert.equal(failed.snapshot().forwardedRequests, 1);
  assert.deepEqual(
    failed.snapshot().requestRecords.map(({ decision }) => decision),
    ['upstream-failed', 'denied-request-limit'],
  );

  const cancelled = await withProxy(t, {
    maxForwardedRequests: 1,
    fetchImpl: async (url, init) => {
      if (String(url).endsWith('/apply-template'))
        return json({ prompt: 'rendered' });
      if (String(url).endsWith('/tokenize')) return json({ tokens: [1] });
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
  const pending = fetch(`${cancelled.url}/v1/chat/completions`, {
    method: 'POST',
    signal: controller.signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: 'small prompt' }],
      max_tokens: 4,
    }),
  }).catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  await pending;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(cancelled.snapshot().forwardedRequests, 1);
  assert.equal(cancelled.snapshot().requestRecords[0].decision, 'cancelled');
});

test('validates request limits and leaves unselected mode uncapped', async (t) => {
  for (const maxForwardedRequests of [0, -1, 1.5, 65, '2'])
    assert.throws(
      () => createPeonMeteringProxy({ maxForwardedRequests }),
      /Invalid forwarded request limit/,
    );
  let completions = 0;
  const meter = await withProxy(t, {
    fetchImpl: async (url) => {
      if (String(url).endsWith('/apply-template'))
        return json({ prompt: 'rendered' });
      if (String(url).endsWith('/tokenize')) return json({ tokens: [1] });
      completions += 1;
      return json({
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    },
  });
  for (let index = 0; index < 3; index += 1)
    assert.equal((await request(meter.url, { max_tokens: 4 })).status, 200);
  assert.equal(completions, 3);
});

test('keeps cumulative usage monotonic and rejects negative upstream counters', async (t) => {
  const meter = await withProxy(t, {
    maxModelTokens: 20,
    fetchImpl: async (url) => {
      if (String(url).endsWith('/apply-template'))
        return json({ prompt: 'rendered' });
      if (String(url).endsWith('/tokenize'))
        return json({ tokens: [1, 2, 3, 4, 5] });
      return json({
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    },
  });
  assert.equal((await request(meter.url, { max_tokens: 4 })).status, 200);
  assert.equal(meter.snapshot().modelTokens, 6);
  assert.equal(meter.snapshot().requestRecords[0].promptTokens, 1);

  for (const streaming of [false, true]) {
    const invalid = await withProxy(t, {
      maxModelTokens: 20,
      fetchImpl: async (url) => {
        if (String(url).endsWith('/apply-template'))
          return json({ prompt: 'rendered' });
        if (String(url).endsWith('/tokenize'))
          return json({ tokens: [1, 2, 3] });
        return streaming
          ? new Response(
              'data: {"choices":[],"usage":{"prompt_tokens":-1,"completion_tokens":1}}\n\ndata: [DONE]\n\n',
              { headers: { 'content-type': 'text/event-stream' } },
            )
          : json({
              choices: [{ message: { role: 'assistant', content: 'bad' } }],
              usage: { prompt_tokens: -1, completion_tokens: 1 },
            });
      },
    });
    assert.equal(
      (await request(invalid.url, { max_tokens: 4, stream: streaming })).status,
      502,
    );
    assert.equal(invalid.snapshot().modelTokens, 7);
    assert.equal(invalid.snapshot().modelTokens >= 0, true);
    assert.equal(
      invalid.snapshot().requestRecords[0].decision,
      'upstream-failed',
    );
  }
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
