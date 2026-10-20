import { createServer } from 'node:http';
import { connect as connectTcp } from 'node:net';

const json = (response, status, value) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
};

async function readJson(request, maxBytes = 5_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('Request body too large.'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON request body.'), { status: 400 }); }
}

function sseUsage(body) {
  let promptTokens = null;
  let completionTokens = null;
  let calls = 0;
  const toolIndexes = new Set();
  for (const block of body.toString('utf8').split(/\r?\n\r?\n/)) {
    const line = block.split(/\r?\n/).find((part) => part.startsWith('data:'));
    if (!line || line.slice(5).trim() === '[DONE]') continue;
    try {
      const event = JSON.parse(line.slice(5).trim());
      if (Number.isSafeInteger(event.usage?.prompt_tokens)) promptTokens = event.usage.prompt_tokens;
      if (Number.isSafeInteger(event.usage?.completion_tokens)) completionTokens = event.usage.completion_tokens;
      for (const [choiceIndex, choice] of (event.choices ?? []).entries()) {
        const delta = choice.delta ?? {};
        if (delta.function_call) toolIndexes.add(`${choiceIndex}:legacy`);
        for (const tool of delta.tool_calls ?? []) {
          if (Number.isSafeInteger(tool.index)) toolIndexes.add(`${choiceIndex}:${tool.index}`);
        }
      }
    } catch { /* malformed frames are passed through only if the complete stream remains valid */ }
  }
  calls = toolIndexes.size;
  return { promptTokens, completionTokens, calls };
}

function jsonUsage(body) {
  const parsed = JSON.parse(body.toString('utf8'));
  return {
    promptTokens: parsed.usage?.prompt_tokens,
    completionTokens: parsed.usage?.completion_tokens,
    calls: (parsed.choices ?? []).reduce((total, choice) => total + (choice.message?.tool_calls?.length ?? (choice.message?.function_call ? 1 : 0)), 0),
    parsed,
  };
}

export function createPeonMeteringProxy({
  upstream = 'http://peon-model:18435',
  maxModelTokens = 32_000,
  maxToolCalls = 64,
  initialModelTokens = 0,
  initialToolCalls = 0,
  allowedConnectHosts = ['api.github.com', 'codeload.github.com', 'github.com', 'objects.githubusercontent.com', 'raw.githubusercontent.com'],
  fetchImpl = fetch,
} = {}) {
  if (!Number.isSafeInteger(maxModelTokens) || maxModelTokens < 1 || maxModelTokens > 64_000) throw new Error('Invalid model token budget.');
  if (!Number.isSafeInteger(maxToolCalls) || maxToolCalls < 1 || maxToolCalls > 128) throw new Error('Invalid tool call budget.');
  if (!Number.isSafeInteger(initialModelTokens) || initialModelTokens < 0 || initialModelTokens > maxModelTokens || !Number.isSafeInteger(initialToolCalls) || initialToolCalls < 0 || initialToolCalls > maxToolCalls) throw new Error('Invalid initial usage counters.');
  const state = { modelTokens: initialModelTokens, toolCalls: initialToolCalls, exceededResource: null, requests: 0, failures: 0, cancellations: 0 };
  let tail = Promise.resolve();
  const locked = (operation) => {
    const current = tail.then(operation, operation);
    tail = current.catch(() => {});
    return current;
  };
  const tokenize = async (content, signal) => {
    const applied = await fetchImpl(`${upstream}/apply-template`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(content), signal });
    if (!applied.ok) throw new Error('Trusted model prompt formatter failed.');
    const { prompt } = await applied.json();
    const tokenized = await fetchImpl(`${upstream}/tokenize`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: prompt, add_special: true }), signal });
    if (!tokenized.ok) throw new Error('Trusted model tokenizer failed.');
    const result = await tokenized.json();
    if (!Array.isArray(result.tokens)) throw new Error('Trusted model tokenizer returned invalid usage.');
    return result.tokens.length;
  };
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      try {
        const upstreamHealth = await fetchImpl(`${upstream}/health`);
        return json(response, upstreamHealth.ok ? 200 : 503, await upstreamHealth.json());
      } catch {
        return json(response, 503, { status: 'unavailable' });
      }
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') return json(response, 404, { error: 'not found' });
    const abort = new AbortController();
    let cancelled = false;
    response.on('close', () => {
      if (!response.writableEnded) { cancelled = true; abort.abort(); }
    });
    try {
      const body = await readJson(request);
      if (!Array.isArray(body.messages) || body.n !== undefined && body.n !== 1) return json(response, 400, { error: 'exactly one chat completion is supported' });
      const outcome = await locked(async () => {
        state.requests += 1;
        let promptTokens;
        try {
          promptTokens = await tokenize({ messages: body.messages, tools: body.tools, tool_choice: body.tool_choice }, abort.signal);
        } catch (error) {
          state.failures += 1;
          throw error;
        }
        const remaining = maxModelTokens - state.modelTokens;
        const asked = body.max_completion_tokens ?? body.max_tokens ?? 2048;
        if (!Number.isSafeInteger(asked) || asked < 1 || promptTokens >= remaining) {
          state.exceededResource = 'model-tokens';
          throw Object.assign(new Error('Model token budget exhausted.'), { status: 429 });
        }
        const outputLimit = Math.min(asked, remaining - promptTokens);
        state.modelTokens += promptTokens;
        body.max_tokens = outputLimit;
        delete body.max_completion_tokens;
        if (body.stream) body.stream_options = { ...(body.stream_options ?? {}), include_usage: true };
        let generatedReservation = outputLimit;
        try {
          const upstreamResponse = await fetchImpl(`${upstream}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: abort.signal });
          const bytes = Buffer.from(await upstreamResponse.arrayBuffer());
          if (!upstreamResponse.ok) {
            state.modelTokens += generatedReservation;
            state.failures += 1;
            return { status: upstreamResponse.status, headers: upstreamResponse.headers, bytes };
          }
          const usage = body.stream ? sseUsage(bytes) : jsonUsage(bytes);
          const actualPrompt = Number.isSafeInteger(usage.promptTokens) ? usage.promptTokens : promptTokens;
          const actualGenerated = Number.isSafeInteger(usage.completionTokens) ? usage.completionTokens : generatedReservation;
          state.modelTokens += actualGenerated;
          generatedReservation = 0;
          state.modelTokens += actualPrompt - promptTokens;
          state.toolCalls += usage.calls;
          if (state.toolCalls > maxToolCalls) {
            state.exceededResource = 'tool-calls';
            return { status: 429, value: { error: 'Tool call budget exhausted.' } };
          }
          if (state.modelTokens > maxModelTokens) {
            state.exceededResource = 'model-tokens';
            return { status: 429, value: { error: 'Model token budget exhausted.' } };
          }
          return { status: upstreamResponse.status, headers: upstreamResponse.headers, bytes };
        } catch (error) {
          state.failures += 1;
          if (cancelled || error.name === 'AbortError') {
            state.cancellations += 1;
            state.modelTokens += generatedReservation;
          } else {
            state.modelTokens += generatedReservation;
          }
          throw error;
        }
      });
      if (cancelled || response.destroyed) return;
      if (outcome.value) return json(response, outcome.status, outcome.value);
      response.writeHead(outcome.status, { 'content-type': outcome.headers.get('content-type') ?? 'application/json' });
      response.end(outcome.bytes);
    } catch (error) {
      if (!cancelled && !response.destroyed) json(response, error.status ?? 502, { error: error.message });
    }
  });
  const usageServer = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/usage') return json(response, 404, { error: 'not found' });
    json(response, 200, { ...state });
  });
  server.on('connect', (request, client, head) => {
    const separator = request.url.lastIndexOf(':');
    const hostname = request.url.slice(0, separator).toLowerCase();
    const port = request.url.slice(separator + 1);
    if (port !== '443' || !allowedConnectHosts.includes(hostname)) {
      client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const upstreamSocket = connectTcp(443, hostname, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstreamSocket.write(head);
      upstreamSocket.pipe(client);
      client.pipe(upstreamSocket);
    });
    upstreamSocket.on('error', () => client.destroy());
    client.on('error', () => upstreamSocket.destroy());
  });
  const egressServer = createServer((_request, response) => json(response, 403, { error: 'only allowlisted HTTPS CONNECT is available' }));
  egressServer.on('connect', server.listeners('connect')[0]);
  const sockets = new Set();
  for (const listener of [server, egressServer, usageServer]) {
    listener.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
  }
  const shutdown = () => {
    for (const socket of sockets) socket.destroy();
    server.close();
    egressServer.close();
    usageServer.close();
  };
  return { server, egressServer, usageServer, shutdown, snapshot: () => ({ ...state }) };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const meter = createPeonMeteringProxy({
    upstream: process.env.STELLAR_MODEL_UPSTREAM,
    maxModelTokens: Number(process.env.STELLAR_MAX_MODEL_TOKENS),
    maxToolCalls: Number(process.env.STELLAR_MAX_TOOL_CALLS),
    initialModelTokens: Number(process.env.STELLAR_INITIAL_MODEL_TOKENS ?? 0),
    initialToolCalls: Number(process.env.STELLAR_INITIAL_TOOL_CALLS ?? 0),
  });
  meter.server.listen(Number(process.env.STELLAR_METER_PORT ?? 18436), '0.0.0.0');
  meter.egressServer.listen(Number(process.env.STELLAR_EGRESS_PROXY_PORT ?? 3128), '0.0.0.0');
  meter.usageServer.listen(Number(process.env.STELLAR_USAGE_PORT ?? 18437), '127.0.0.1');
  process.on('SIGTERM', () => { meter.shutdown(); process.exit(0); });
  process.on('SIGINT', () => { meter.shutdown(); process.exit(0); });
}
