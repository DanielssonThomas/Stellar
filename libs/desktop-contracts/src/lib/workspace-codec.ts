import type {
  WorkspacePaneMetadata,
  WorkspacePaneOperation,
  WorkspaceRenderState,
  WorkspaceProminence,
  WorkspaceSurface,
  WorkspaceToolOperation,
  WorkspaceToolOutcome,
  WorkspaceToolRequest,
  WorkspaceMutationStatus,
} from '../generated';
import {
  workspaceBatchMaxOperations,
  workspaceBatchMaxPayloadBytes,
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
  'activity-summary': true,
};
const prominence: Record<WorkspaceProminence, true> = {
  primary: true,
  secondary: true,
};
const renderStates: Record<WorkspaceRenderState, true> = {
  ready: true,
  loading: true,
  error: true,
  hidden: true,
  unavailable: true,
};
const payloadLimits: Record<WorkspaceSurface, number> = {
  'rich-text': 65536,
  image: 65536,
  'assistant-message': 65536,
  diagram: 16384,
  browser: 4096,
  workflow: 2048,
  session: 2048,
  'activity-summary': 0,
};
const mutations = new Set([
  'open',
  'update',
  'remove',
  'focus',
  'minimize',
  'restore',
  'maximize',
  'resize',
  'swap',
  'restore_layout',
  'arrange',
  'clear',
]);

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
  if (kind === 'batch') {
    const data = record(value, ['kind', 'operations']);
    const entries = data['operations'];
    if (
      !Array.isArray(entries) ||
      entries.length < 1 ||
      entries.length > workspaceBatchMaxOperations ||
      entries.some(
        (entry) =>
          typeof entry !== 'object' ||
          entry === null ||
          !mutations.has(entry['kind']),
      )
    )
      throw new DesktopContractError('malformed');
    const operations = entries.map(operation);
    if (
      operations.reduce(
        (bytes, entry) =>
          bytes +
          ('payload_json' in entry
            ? new TextEncoder().encode(entry.payload_json).length
            : 0),
        0,
      ) > workspaceBatchMaxPayloadBytes
    )
      throw new DesktopContractError('malformed');
    return { kind, operations };
  }
  if (
    kind === 'clear' ||
    kind === 'inspect' ||
    kind === 'capture_window' ||
    kind === 'capture_foreground' ||
    kind === 'list_displays' ||
    kind === 'restore_layout'
  ) {
    record(value, ['kind']);
    return { kind };
  }
  if (kind === 'capture_display') {
    const data = record(value, ['kind', 'display_id']);
    const display_id =
      data['display_id'] === null
        ? null
        : boundedString(data['display_id'], 128);
    if (
      display_id !== null &&
      (!display_id ||
        Array.from(display_id).some(
          (char) =>
            char.charCodeAt(0) < 32 ||
            (char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159),
        ))
    )
      throw new DesktopContractError('malformed');
    return { kind, display_id };
  }
  if (
    kind === 'focus' ||
    kind === 'remove' ||
    kind === 'minimize' ||
    kind === 'restore' ||
    kind === 'maximize' ||
    kind === 'inspect_content'
  ) {
    const data = record(value, ['kind', 'instance_id']);
    return { kind, instance_id: id(data['instance_id']) };
  }
  if (kind === 'resize') {
    const data = record(value, ['kind', 'instance_id', 'percent']);
    const percent = data['percent'];
    if (
      typeof percent !== 'number' ||
      !Number.isInteger(percent) ||
      percent < 10 ||
      percent > 90
    )
      throw new DesktopContractError('malformed');
    return { kind, instance_id: id(data['instance_id']), percent };
  }
  if (kind === 'swap') {
    const data = record(value, ['kind', 'instance_id', 'other_id']);
    const instance_id = id(data['instance_id']),
      other_id = id(data['other_id']);
    if (instance_id === other_id) throw new DesktopContractError('malformed');
    return { kind, instance_id, other_id };
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
    ...(kind === 'open'
      ? ['prominence']
      : Object.hasOwn(value, 'expected_revision')
        ? ['expected_revision']
        : []),
  ]);
  if (kind === 'update' && Object.hasOwn(data, 'expected_revision'))
    integer(data['expected_revision'], 4294967295);
  const surface = choice(data['surface'], surfaces);
  if (surface === 'activity-summary')
    throw new DesktopContractError('unknown-variant');
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
    : {
        kind,
        ...shared,
        ...(Object.hasOwn(data, 'expected_revision')
          ? {
              expected_revision: integer(data['expected_revision'], 4294967295),
            }
          : {}),
      };
}

export function decodeWorkspaceToolRequest(
  value: unknown,
): WorkspaceToolRequest {
  const data = record(value, [
    'version',
    'request_id',
    'epoch',
    'turn_id',
    'expires_at_ms',
    'operation',
  ]);
  const request = boundedString(data['request_id'], 32);
  const turn = boundedString(data['turn_id'], 36);
  if (
    !/^[0-9a-f]{32}$/.test(request) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(turn)
  )
    throw new DesktopContractError('malformed');
  const expiresAt = sequence(data['expires_at_ms']);
  if (!Number.isSafeInteger(Number(expiresAt)) || Number(expiresAt) <= 0)
    throw new DesktopContractError('malformed');
  return {
    version: version(data['version']),
    request_id: request,
    epoch: sequence(data['epoch']),
    turn_id: turn,
    expires_at_ms: expiresAt,
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
      ![
        'capture_window',
        'capture_display',
        'capture_foreground',
        'list_displays',
        'batch',
      ].includes(request.operation.kind))
  ) {
    record(value, ['kind']);
    return { kind };
  }
  if (kind === 'batch' && request.operation.kind === 'batch') {
    const data = record(value, ['kind', 'outcomes', 'panes']);
    if (
      !Array.isArray(data['outcomes']) ||
      data['outcomes'].length !== request.operation.operations.length
    )
      throw new DesktopContractError('malformed');
    const statuses: Record<WorkspaceMutationStatus, true> = {
      applied: true,
      rejected: true,
      uncertain: true,
    };
    return {
      kind,
      outcomes: data['outcomes'].map((entry) => choice(entry, statuses)),
      panes: data['panes'] === null ? null : decodePanes(data['panes']),
    };
  }
  if (kind === 'content' && request.operation.kind === 'inspect_content') {
    const data = record(value, [
      'kind',
      'instance_id',
      'surface',
      'revision',
      'payload_json',
    ]);
    if (id(data['instance_id']) !== request.operation.instance_id)
      throw new DesktopContractError('malformed');
    const surface = choice(data['surface'], surfaces);
    if (surface === 'activity-summary')
      throw new DesktopContractError('malformed');
    return {
      kind,
      instance_id: id(data['instance_id']),
      surface,
      revision: integer(data['revision'], 4294967295),
      payload_json: boundedString(data['payload_json'], payloadLimits[surface]),
    };
  }
  if (kind !== 'inspection' || request.operation.kind !== 'inspect')
    throw new DesktopContractError('malformed');
  const data = record(value, ['kind', 'panes']);
  return { kind, panes: decodePanes(data['panes']) };
}

function decodePanes(value: unknown): WorkspacePaneMetadata[] {
  if (!Array.isArray(value) || value.length > 4)
    throw new DesktopContractError('malformed');
  const panes: WorkspacePaneMetadata[] = value.map((item) => {
    const pane = record(item, [
      'instance_id',
      'surface',
      'prominence',
      'minimized',
      ...(typeof item === 'object' &&
      item !== null &&
      Object.hasOwn(item, 'render_state')
        ? ['render_state']
        : []),
      ...(typeof item === 'object' &&
      item !== null &&
      Object.hasOwn(item, 'layout')
        ? ['layout']
        : []),
      ...(typeof item === 'object' &&
      item !== null &&
      Object.hasOwn(item, 'operations')
        ? ['operations']
        : []),
    ]);
    if (typeof pane['minimized'] !== 'boolean')
      throw new DesktopContractError('malformed');
    return {
      instance_id: id(pane['instance_id']),
      surface: choice(pane['surface'], surfaces),
      prominence: choice(pane['prominence'], prominence),
      minimized: pane['minimized'],
      ...(pane['render_state'] == null
        ? {}
        : { render_state: choice(pane['render_state'], renderStates) }),
      ...(pane['operations'] === undefined
        ? {}
        : { operations: paneOperations(pane['operations']) }),
      ...(pane['layout'] == null
        ? {}
        : { layout: decodePaneLayout(pane['layout']) }),
    };
  });
  if (new Set(panes.map((pane) => pane.instance_id)).size !== panes.length)
    throw new DesktopContractError('malformed');
  return panes;
}

function integer(value: unknown, max: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > max
  )
    throw new DesktopContractError('malformed');
  return value;
}
function decodePaneLayout(value: unknown) {
  const p = record(value, [
    'title',
    'revision',
    'selected',
    'maximized',
    'position',
    'x',
    'y',
    'width',
    'height',
  ]);
  if (typeof p['selected'] !== 'boolean' || typeof p['maximized'] !== 'boolean')
    throw new DesktopContractError('malformed');
  const x = integer(p['x'], 1000),
    y = integer(p['y'], 1000),
    width = integer(p['width'], 1000),
    height = integer(p['height'], 1000);
  if (x + width > 1001 || y + height > 1001)
    throw new DesktopContractError('malformed');
  return {
    title: boundedString(p['title'], 960),
    revision: integer(p['revision'], 4294967295),
    selected: p['selected'],
    maximized: p['maximized'],
    position: integer(p['position'], 3),
    x,
    y,
    width,
    height,
  };
}

function paneOperations(value: unknown): WorkspacePaneOperation[] {
  const choices: Record<WorkspacePaneOperation, true> = {
    focus: true,
    minimize: true,
    restore: true,
    close: true,
    arrange: true,
    swap: true,
    resize: true,
    maximize: true,
    restore_layout: true,
    update: true,
    inspect_content: true,
    gallery: true,
    browser_navigation: true,
    focus_agent: true,
  };
  if (!Array.isArray(value) || value.length > 14)
    throw new DesktopContractError('malformed');
  const operations = value.map((item) => choice(item, choices));
  if (new Set(operations).size !== operations.length)
    throw new DesktopContractError('malformed');
  return operations;
}
