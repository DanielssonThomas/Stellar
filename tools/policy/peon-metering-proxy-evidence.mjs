import { fileURLToPath } from 'node:url';

// The pinned image keeps serving and accounting for completions. This opt-in
// wrapper replaces only its local usage listener with a sanitized tool log.
const baseSource = fileURLToPath(import.meta.url).startsWith('/opt/')
  ? 'file:///opt/stellar-peon-metering-proxy.mjs'
  : './peon-metering-proxy.mjs';
const { createPeonMeteringProxy: createBaseMeter } = await import(baseSource);
const maxToolEvents = 128;
const allowedTools = new Set([
  'terminal',
  'process_manage',
  'read_file',
  'write_file',
  'patch',
  'search_files',
  'skills_list',
  'skill_view',
  'tool_search',
  'tool_describe',
  'tool_call',
]);

const json = (response, status, value) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
};

export function validSanitizedToolEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
  const pre = event.phase === 'pre';
  const post = event.phase === 'post';
  if (!pre && !post) return false;
  const keys = pre
    ? ['phase', 'callId', 'toolName', 'argumentBytes', 'argumentCount']
    : [
        'phase',
        'callId',
        'toolName',
        'argumentBytes',
        'argumentCount',
        'status',
        'elapsedMs',
        'outputBytes',
        'exitCode',
      ];
  if (
    Object.keys(event).length !== keys.length ||
    Object.keys(event).some((key) => !keys.includes(key))
  )
    return false;
  const count = (value, maximum) =>
    Number.isSafeInteger(value) && value >= 0 && value <= maximum;
  return (
    /^[a-f0-9]{24}$/.test(event.callId ?? '') &&
    allowedTools.has(event.toolName) &&
    count(event.argumentBytes, 1_000_000) &&
    count(event.argumentCount, 256) &&
    (pre ||
      (['ok', 'error', 'cancelled', 'blocked', 'timeout', 'unknown'].includes(
        event.status,
      ) &&
        (event.elapsedMs === null || count(event.elapsedMs, 900_000)) &&
        count(event.outputBytes, 1_000_000) &&
        (event.exitCode === null ||
          (Number.isSafeInteger(event.exitCode) &&
            event.exitCode >= -255 &&
            event.exitCode <= 255))))
  );
}

async function readEvent(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2048) throw new Error('oversized event');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createPeonMeteringProxy(options) {
  const meter = createBaseMeter(options);
  const toolEvents = [];
  meter.usageServer.removeAllListeners('request');
  meter.usageServer.on('request', async (request, response) => {
    if (request.method === 'GET' && request.url === '/usage')
      return json(response, 200, { ...meter.snapshot(), toolEvents });
    if (request.method !== 'POST' || request.url !== '/tool-event')
      return json(response, 404, { error: 'not found' });
    try {
      const event = await readEvent(request);
      if (!validSanitizedToolEvent(event))
        return json(response, 400, { error: 'invalid tool metadata' });
      if (toolEvents.length >= maxToolEvents)
        return json(response, 429, { error: 'tool evidence limit exhausted' });
      if (
        event.phase === 'post' &&
        !toolEvents.some(
          (prior) =>
            prior.phase === 'pre' &&
            prior.callId === event.callId &&
            prior.toolName === event.toolName,
        )
      )
        return json(response, 409, { error: 'unmatched tool result' });
      toolEvents.push(event);
      response.writeHead(204);
      return response.end();
    } catch {
      return json(response, 400, { error: 'invalid tool metadata' });
    }
  });
  return { ...meter, snapshot: () => ({ ...meter.snapshot(), toolEvents }) };
}

if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  const meter = createPeonMeteringProxy({
    upstream: process.env.STELLAR_MODEL_UPSTREAM,
    maxModelTokens: Number(process.env.STELLAR_MAX_MODEL_TOKENS),
    maxToolCalls: Number(process.env.STELLAR_MAX_TOOL_CALLS),
    maxForwardedRequests: Number(process.env.STELLAR_MAX_FORWARDED_REQUESTS),
    initialModelTokens: Number(process.env.STELLAR_INITIAL_MODEL_TOKENS ?? 0),
    initialToolCalls: Number(process.env.STELLAR_INITIAL_TOOL_CALLS ?? 0),
  });
  meter.server.listen(
    Number(process.env.STELLAR_METER_PORT ?? 18436),
    '0.0.0.0',
  );
  meter.egressServer.listen(
    Number(process.env.STELLAR_EGRESS_PROXY_PORT ?? 3128),
    '0.0.0.0',
  );
  meter.usageServer.listen(
    Number(process.env.STELLAR_USAGE_PORT ?? 18437),
    '0.0.0.0',
  );
  process.on('SIGTERM', meter.shutdown);
  process.on('SIGINT', meter.shutdown);
}
