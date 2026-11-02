import {
  DesktopContractError,
  boundedString,
  record,
  version,
} from './wire-validation';
import type { TelemetrySnapshot } from '../generated';

const fail = (): never => {
  throw new DesktopContractError('malformed');
};
const oneOf = (v: unknown, choices: readonly string[]) =>
  typeof v === 'string' && choices.includes(v) ? v : fail();
const str = (v: unknown, max: number) => {
  const s = boundedString(v, max);
  if (!s || [...s].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127))
    fail();
  return s;
};
const maybe = <T>(v: unknown, decode: (v: unknown) => T): T | null =>
  v === null ? null : decode(v);
const date = (v: unknown) => {
  const s = str(v, 35);
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(s) ||
    !Number.isFinite(Date.parse(s))
  )
    fail();
  return s;
};
const uint = (v: unknown) =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffffffff
    ? v
    : fail();
const id = (v: unknown) => {
  const s = str(v, 64);
  return /^[a-zA-Z0-9-]+$/.test(s) ? s : fail();
};
const hash = (v: unknown) => {
  const s = str(v, 16);
  return /^[a-fA-F0-9]{16}$/.test(s) ? s : fail();
};
const labels = [
  'Terminal',
  'Reading files',
  'Editing files',
  'Browser',
  'Web search',
  'Blender',
  'VRoid',
  'Tool invocation',
  'Processing a turn',
  'Running a command',
  'Using a connected tool',
  'Inspecting an image',
  'Searching the web',
  'Coordinating agents',
  'Generating an image',
  'Posted an update',
  'Codex turn in progress',
  'Session ended with an error',
  'Session ended',
  'Turn failed',
  'Turn completed',
];
const label = (v: unknown) => oneOf(v, labels);
const model = (v: unknown) => {
  const s = str(v, 100);
  return /^[a-zA-Z0-9._/-]+$/.test(s) && !s['includes']('..') ? s : fail();
};
const names: Record<string, string> = {
  architect: 'Architect',
  'architect-cloud': 'Architect Cloud',
  foreman: 'Foreman',
  'foreman-cloud': 'Foreman Cloud',
  peon: 'Peon',
  'peon-cloud': 'Peon Cloud',
  mira: 'Mira',
  designer: 'Designer',
  'art-director': 'Art Director',
};
export function decodeTelemetrySnapshot(input: unknown): TelemetrySnapshot {
  const s = record(input, [
    'schemaVersion',
    'sequence',
    'observedAt',
    'agents',
  ]);
  version(s['schemaVersion']);
  uint(s['sequence']);
  date(s['observedAt']);
  if (!Array.isArray(s['agents']) || s['agents'].length > 17) fail();
  for (const raw of s['agents'] as unknown[]) {
    const a = record(raw, [
      'id',
      'name',
      'project',
      'state',
      'sessionId',
      'task',
      'activity',
      'tool',
      'model',
      'provider',
      'usage',
      'startedAt',
      'lastObservedAt',
      'source',
      'events',
    ]);
    id(a['id']);
    str(a['name'], 80);
    oneOf(a['project'], ['stellar', 'stellar-design']);
    oneOf(a['state'], [
      'running',
      'completed',
      'failed',
      'disconnected',
      'unknown',
    ]);
    maybe(a['sessionId'], hash);
    if (a['task'] !== null) fail();
    maybe(a['activity'], label);
    maybe(a['tool'], label);
    maybe(a['model'], model);
    maybe(a['provider'], model);
    maybe(a['startedAt'], date);
    maybe(a['lastObservedAt'], date);
    if (a['usage'] !== null) {
      const u = record(a['usage'], ['inputTokens', 'outputTokens']);
      uint(u['inputTokens']);
      uint(u['outputTokens']);
    }
    const source = record(a['source'], ['kind', 'health', 'observedAt']);
    oneOf(source['kind'], ['hermes-turn-lease', 'codex-local-turn-history']);
    const agentId = id(a['id']);
    const agentName = str(a['name'], 80);
    const codex = /^codex-([a-fA-F0-9]{16})$/.exec(agentId);
    if (
      source['kind'] === 'hermes-turn-lease'
        ? !Object.hasOwn(names, agentId) || names[agentId] !== agentName
        : agentId === 'codex-source'
          ? agentName !== 'Codex sessions'
          : !codex ||
            agentName !== `Codex ${codex[1].slice(0, 4).toUpperCase()}`
    )
      fail();
    oneOf(source['health'], ['available', 'unavailable']);
    date(source['observedAt']);
    if (!Array.isArray(a['events']) || a['events'].length > 41) fail();
    for (const rawEvent of a['events'] as unknown[]) {
      const e = record(rawEvent, ['id', 'at', 'kind', 'label']);
      maybe(e['id'], hash);
      maybe(e['at'], date);
      oneOf(e['kind'], ['tool', 'failure', 'completion']);
      label(e['label']);
    }
  }
  return input as TelemetrySnapshot;
}
