import type {
  IvyConnectionState,
  IvyComponent,
  IvyTurnState,
  IvyErrorCode,
  IvyPresentation,
  IvyRequest,
  IvySubmitRequest,
  IvySnapshot,
} from '../generated';
import {
  record,
  version,
  boundedString,
  sequence,
  DesktopContractError,
} from './wire-validation';

const connections: Record<IvyConnectionState, true> = {
  disconnected: true,
  connecting: true,
  ready: true,
  unavailable: true,
};
const turns: Record<IvyTurnState, true> = {
  idle: true,
  submitting: true,
  admitted: true,
  completed: true,
  cancelled: true,
  uncertain: true,
};
const errors: Record<IvyErrorCode, true> = {
  malformed_request: true,
  unavailable: true,
  timeout: true,
  busy: true,
  protocol: true,
  uncertain: true,
  storage: true,
  approval_required: true,
};

const components: Record<IvyComponent, true> = { assistant_message: true };
const kinds: Record<IvyPresentation['kind'], true> = {
  text: true,
  component: true,
};

function variant<T extends string>(value: unknown, values: Record<T, true>): T {
  if (typeof value !== 'string' || !Object.hasOwn(values, value))
    throw new DesktopContractError('unknown-variant');
  return value as T;
}

function identifier(value: unknown): string {
  const result = boundedString(value, 36);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      result,
    )
  )
    throw new DesktopContractError('malformed');
  return result;
}

function text(value: unknown, bytes: number): string {
  const result = boundedString(value, bytes);
  if (!result.trim()) throw new DesktopContractError('malformed');
  return result;
}

export function decodeIvyRequest(value: unknown): IvyRequest {
  const data = record(value, ['version']);
  return { version: version(data['version']) };
}

export function decodeIvySubmitRequest(value: unknown): IvySubmitRequest {
  const data = record(value, ['version', 'input_id', 'text']);
  return {
    version: version(data['version']),
    input_id: identifier(data['input_id']),
    text: text(data['text'], 8192),
  };
}

export function decodeIvyError(value: unknown): IvyErrorCode {
  return variant(value, errors);
}

function presentation(value: unknown): IvyPresentation {
  if (typeof value !== 'object' || value === null)
    throw new DesktopContractError('malformed');
  const kind = variant((value as Record<string, unknown>)['kind'], kinds);
  if (kind === 'text') {
    const data = record(value, ['kind', 'text']);
    return { kind: 'text', text: text(data['text'], 16384) };
  }
  const data = record(value, ['kind', 'component', 'title', 'body']);
  return {
    kind: 'component',
    component: variant(data['component'], components),
    title: text(data['title'], 160),
    body: text(data['body'], 8192),
  };
}

export function decodeIvySnapshot(value: unknown): IvySnapshot {
  const data = record(value, [
    'version',
    'revision',
    'turn_id',
    'connection',
    'turn',
    'items',
    'error',
  ]);
  const items = data['items'];
  if (!Array.isArray(items) || items.length > 2)
    throw new DesktopContractError('malformed');
  const decoded = items.map(presentation);
  if (new Set(decoded.map((item) => item.kind)).size !== decoded.length)
    throw new DesktopContractError('malformed');
  const snapshot: IvySnapshot = {
    version: version(data['version']),
    revision: sequence(data['revision']),
    turn_id: data['turn_id'] === null ? null : identifier(data['turn_id']),
    connection: variant(data['connection'], connections),
    turn: variant(data['turn'], turns),
    items: decoded,
    error: data['error'] === null ? null : decodeIvyError(data['error']),
  };
  if (new TextEncoder().encode(JSON.stringify(snapshot)).length > 65536)
    throw new DesktopContractError('malformed');
  return snapshot;
}
