import type {
  WorkspacePaneMetadata,
  WorkspaceProminence,
  WorkspaceSurface,
  WorkspaceToolOperation,
  WorkspaceToolOutcome,
  WorkspaceToolRequest,
} from '../generated';
import {
  boundedString,
  DesktopContractError,
  record,
  sequence,
  version,
} from './wire-validation';

const surfaces: Record<WorkspaceSurface, true> = {
  'rich-text': true,
  image: true,
  browser: true,
  diagram: true,
  workflow: true,
  session: true,
  'assistant-message': true,
};
const prominence: Record<WorkspaceProminence, true> = {
  primary: true,
  secondary: true,
};
const payloadLimits: Record<WorkspaceSurface, number> = {
  'rich-text': 65536, image: 65536, 'assistant-message': 65536,
  diagram: 16384, browser: 4096, workflow: 2048, session: 2048,
};

function choice<T extends string>(value: unknown, choices: Record<T, true>): T {
  if (typeof value !== 'string' || !Object.hasOwn(choices, value))
    throw new DesktopContractError('unknown-variant');
  return value as T;
}
function id(value: unknown): string {
  const result = boundedString(value, 64);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(result))
    throw new DesktopContractError('malformed');
  return result;
}
function operation(value: unknown): WorkspaceToolOperation {
  if (typeof value !== 'object' || value === null)
    throw new DesktopContractError('malformed');
  const kind = (value as Record<string, unknown>)['kind'];
  if (kind === 'clear' || kind === 'inspect' || kind === 'capture_window') {
    record(value, ['kind']);
    return { kind };
  }
  if (kind === 'focus' || kind === 'remove') {
    const data = record(value, ['kind', 'instance_id']);
    return { kind, instance_id: id(data['instance_id']) };
  }
  if (kind === 'arrange') {
    const data = record(value, ['kind', 'instance_ids']);
    if (!Array.isArray(data['instance_ids']) || data['instance_ids'].length > 4)
      throw new DesktopContractError('malformed');
    const ids = data['instance_ids'].map(id);
    if (new Set(ids).size !== ids.length)
      throw new DesktopContractError('malformed');
    return { kind, instance_ids: ids };
  }
  if (kind !== 'open' && kind !== 'update')
    throw new DesktopContractError('unknown-variant');
  const data = record(value, [
    'kind',
    'instance_id',
    'surface',
    'payload_json',
    ...(kind === 'open' ? ['prominence'] : []),
  ]);
  const surface = choice(data['surface'], surfaces);
  const payload = boundedString(data['payload_json'], payloadLimits[surface]);
  try {
    const parsed: unknown = JSON.parse(payload);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      throw new Error();
    const remaining: unknown[] = [parsed];
    while (remaining.length) {
      const next = remaining.pop();
      if (typeof next === 'number' && !Number.isFinite(next)) throw new Error();
      if (typeof next === 'object' && next !== null)
        remaining.push(...Object.values(next));
    }
  } catch {
    throw new DesktopContractError('malformed');
  }
  const shared = {
    instance_id: id(data['instance_id']),
    surface,
    payload_json: payload,
  };
  return kind === 'open'
    ? { kind, ...shared, prominence: choice(data['prominence'], prominence) }
    : { kind, ...shared };
}

export function decodeWorkspaceToolRequest(
  value: unknown,
): WorkspaceToolRequest {
  const data = record(value, [
    'version',
    'request_id',
    'epoch',
    'turn_id',
    'operation',
  ]);
  const request = boundedString(data['request_id'], 32);
  const turn = boundedString(data['turn_id'], 36);
  if (
    !/^[0-9a-f]{32}$/.test(request) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(turn)
  )
    throw new DesktopContractError('malformed');
  return {
    version: version(data['version']),
    request_id: request,
    epoch: sequence(data['epoch']),
    turn_id: turn,
    operation: operation(data['operation']),
  };
}

export function decodeWorkspaceToolOutcome(
  value: unknown,
  request: WorkspaceToolRequest,
): WorkspaceToolOutcome {
  if (typeof value !== 'object' || value === null)
    throw new DesktopContractError('malformed');
  const kind = (value as Record<string, unknown>)['kind'];
  if (
    kind === 'rejected' ||
    (kind === 'applied' &&
      request.operation.kind !== 'inspect' &&
      request.operation.kind !== 'capture_window')
  ) {
    record(value, ['kind']);
    return { kind };
  }
  if (kind !== 'inspection' || request.operation.kind !== 'inspect')
    throw new DesktopContractError('malformed');
  const data = record(value, ['kind', 'panes']);
  if (!Array.isArray(data['panes']) || data['panes'].length > 4)
    throw new DesktopContractError('malformed');
  const panes: WorkspacePaneMetadata[] = data['panes'].map((item) => {
    const pane = record(item, [
      'instance_id',
      'surface',
      'prominence',
      'minimized',
    ]);
    if (typeof pane['minimized'] !== 'boolean')
      throw new DesktopContractError('malformed');
    return {
      instance_id: id(pane['instance_id']),
      surface: choice(pane['surface'], surfaces),
      prominence: choice(pane['prominence'], prominence),
      minimized: pane['minimized'],
    };
  });
  if (new Set(panes.map((pane) => pane.instance_id)).size !== panes.length)
    throw new DesktopContractError('malformed');
  return { kind, panes };
}
