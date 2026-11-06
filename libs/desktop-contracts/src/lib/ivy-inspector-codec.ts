import type {
  IvyInspectorSnapshot,
  IvySessionSummary,
  IvySessionMessage,
  IvyUsageWindow,
} from '../generated';
import {
  record,
  version,
  boundedString,
  DesktopContractError,
} from './wire-validation';

function number(value: unknown, maximum = 4294967295): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > maximum
  )
    throw new DesktopContractError('malformed');
  return value;
}
function nullable<T>(value: unknown, decode: (v: unknown) => T): T | null {
  return value === null ? null : decode(value);
}
function text(value: unknown, maximum: number): string {
  const result = boundedString(value, maximum * 4);
  if (
    [...result].length > maximum ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(result)
  )
    throw new DesktopContractError('malformed');
  return result;
}
function stamp(value: unknown): string | null {
  return nullable(value, (v) => {
    const result = text(v, 64);
    if (!Number.isFinite(Date.parse(result)))
      throw new DesktopContractError('malformed');
    return result;
  });
}
function list<T>(
  value: unknown,
  maximum: number,
  decode: (v: unknown) => T,
): T[] {
  if (!Array.isArray(value) || value.length > maximum)
    throw new DesktopContractError('malformed');
  return value.map(decode);
}
function summary(value: unknown): IvySessionSummary {
  const r = record(value, [
    'id',
    'title',
    'model',
    'started_at',
    'last_activity_at',
    'message_count',
  ]);
  const id = text(r['id'], 512);
  if (!id) throw new DesktopContractError('malformed');
  return {
    id,
    title: text(r['title'], 160),
    model: nullable(r['model'], (v) => text(v, 120)),
    started_at: stamp(r['started_at']),
    last_activity_at: stamp(r['last_activity_at']),
    message_count: number(r['message_count']),
  };
}
function message(value: unknown): IvySessionMessage {
  const r = record(value, ['id', 'role', 'text', 'at']);
  const role = r['role'];
  if (role !== 'user' && role !== 'assistant')
    throw new DesktopContractError('unknown-variant');
  const id = number(r['id']);
  if (!id) throw new DesktopContractError('malformed');
  return { id, role, text: text(r['text'], 2000), at: stamp(r['at']) };
}
function window(value: unknown): IvyUsageWindow {
  const r = record(value, ['label', 'used_percent', 'reset_at', 'scope']);
  const used = nullable(r['used_percent'], (v) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100)
      throw new DesktopContractError('malformed');
    return v;
  });
  if (r['scope'] !== 'model' && r['scope'] !== 'account')
    throw new DesktopContractError('unknown-variant');
  return {
    label: text(r['label'], 80),
    used_percent: used,
    reset_at: stamp(r['reset_at']),
    scope: r['scope'],
  };
}
export function decodeIvyInspectorSnapshot(
  value: unknown,
): IvyInspectorSnapshot {
  const r = record(value, [
    'version',
    'observed_at',
    'active_session_id',
    'active_stored_session_id',
    'selected_session_id',
    'history_available',
    'sessions',
    'next_offset',
    'messages',
    'next_before',
    'context',
    'account',
  ]);
  version(r['version']);
  if (typeof r['history_available'] !== 'boolean')
    throw new DesktopContractError('malformed');
  const context = record(r['context'], [
    'observed_at',
    'used',
    'limit',
    'compactions',
  ]);
  const account = record(r['account'], ['state', 'observed_at', 'windows']);
  const state = account['state'];
  if (state !== 'loading' && state !== 'available' && state !== 'unavailable')
    throw new DesktopContractError('unknown-variant');
  const observed = stamp(r['observed_at']);
  if (observed === null) throw new DesktopContractError('malformed');
  const result: IvyInspectorSnapshot = {
    version: 1,
    observed_at: observed,
    active_session_id: nullable(r['active_session_id'], (v) => text(v, 512)),
    active_stored_session_id: nullable(r['active_stored_session_id'], (v) =>
      text(v, 512),
    ),
    selected_session_id: nullable(r['selected_session_id'], (v) =>
      text(v, 512),
    ),
    history_available: r['history_available'],
    sessions: list(r['sessions'], 41, summary),
    next_offset: nullable(r['next_offset'], (v) => number(v, 1960)),
    messages: list(r['messages'], 40, message),
    next_before: nullable(r['next_before'], (v) => number(v)),
    context: {
      observed_at: stamp(context['observed_at']),
      used: nullable(context['used'], number),
      limit: nullable(context['limit'], number),
      compactions: nullable(context['compactions'], number),
    },
    account: {
      state,
      observed_at: stamp(account['observed_at']),
      windows: list(account['windows'], 8, window),
    },
  };
  if (
    (result.context.used !== null &&
      result.context.limit !== null &&
      result.context.used > result.context.limit) ||
    (result.selected_session_id !== null &&
      !result.sessions.some((s) => s.id === result.selected_session_id)) ||
    new Set(result.sessions.map((s) => s.id)).size !== result.sessions.length ||
    new Set(result.messages.map((m) => m.id)).size !== result.messages.length
  )
    throw new DesktopContractError('malformed');
  return result;
}
