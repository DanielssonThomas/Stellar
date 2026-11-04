import type {
  ReflexReply,
  ReflexMediaState,
  ReflexMediaResult,
  ReflexAvailability,
  ReflexRouting,
} from '../generated';

const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, names: string[]) =>
  Object.keys(v).length === names.length &&
  names.every((key) => Object.hasOwn(v, key));
const text = (v: unknown, max: number): v is string =>
  typeof v === 'string' && new TextEncoder().encode(v).length <= max;

export function decodeReflexAvailability(v: unknown): ReflexAvailability {
  if (
    !record(v) ||
    !keys(v, ['version', 'configured']) ||
    v['version'] !== 1 ||
    typeof v['configured'] !== 'boolean'
  )
    throw new Error('Invalid Reflex availability');
  return v as unknown as ReflexAvailability;
}

export function decodeReflexRouting(v: unknown): ReflexRouting {
  if (
    !record(v) ||
    !keys(v, ['version', 'local']) ||
    v['version'] !== 1 ||
    typeof v['local'] !== 'boolean'
  )
    throw new Error('Invalid Reflex routing');
  return v as unknown as ReflexRouting;
}

export function decodeReflexReply(v: unknown, inputId: string): ReflexReply {
  if (
    !record(v) ||
    !keys(v, ['version', 'input_id', 'plan']) ||
    v['version'] !== 1 ||
    v['input_id'] !== inputId
  )
    throw new Error('Invalid Reflex reply');
  const p = v['plan'];
  if (
    p !== null &&
    (!record(p) ||
      !keys(p, ['route', 'action_id', 'reply']) ||
      !['action', 'clarify', 'hermes'].includes(String(p['route'])) ||
      !text(p['reply'], 160) ||
      !p['reply'].trim() ||
      p['reply'].trim().split(/\s+/).length >= 12 ||
      /[\p{Cc}<>]/u.test(p['reply']) ||
      (p['route'] === 'action'
        ? !text(p['action_id'], 96) || !p['action_id']
        : p['action_id'] !== null))
  )
    throw new Error('Invalid Reflex plan');
  return v as unknown as ReflexReply;
}

export function decodeReflexMediaState(v: unknown): ReflexMediaState {
  const allowed = [
    'play',
    'pause',
    'next',
    'previous',
    'volume_up',
    'volume_down',
    'mute',
    'unmute',
    'inspect',
  ];
  if (
    !record(v) ||
    !keys(v, [
      'ticket',
      'player',
      'title',
      'playing',
      'volume',
      'muted',
      'endpoint_id',
      'actions',
    ]) ||
    !text(v['ticket'], 32) ||
    !/^\d+$/.test(v['ticket']) ||
    ![v['player'], v['title']].every((s) => s === null || text(s, 960)) ||
    typeof v['playing'] !== 'boolean' ||
    !(v['endpoint_id'] === null || text(v['endpoint_id'], 1024)) ||
    !(
      v['volume'] === null ||
      (Number.isInteger(v['volume']) &&
        Number(v['volume']) >= 0 &&
        Number(v['volume']) <= 100)
    ) ||
    !(v['muted'] === null || typeof v['muted'] === 'boolean') ||
    !Array.isArray(v['actions']) ||
    v['actions'].length > allowed.length ||
    new Set(v['actions']).size !== v['actions'].length ||
    !v['actions'].every((s) => allowed.includes(s))
  )
    throw new Error('Invalid media state');
  return v as unknown as ReflexMediaState;
}

export function decodeReflexMediaResult(v: unknown): ReflexMediaResult {
  if (v !== 'confirmed' && v !== 'rejected' && v !== 'uncertain')
    throw new Error('Invalid media result');
  return v;
}
