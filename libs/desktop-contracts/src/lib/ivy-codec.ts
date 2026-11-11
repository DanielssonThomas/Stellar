import type {
  IvyActivity,
  IvyActivityKind,
  IvyActivityState,
  IvyActivityProvider,
  IvyActivityOperation,
  IvyConnectionState,
  IvyComponent,
  IvyTurnState,
  IvyErrorCode,
  IvyPresentation,
  IvyModel,
  IvySelectRequest,
  IvyRequest,
  IvySubmitRequest,
  IvySnapshot,
  IvyQuestion,
  IvyQuestionReplyRequest,
  IvyResponseSegment,
  WorkspaceToolsState,
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
  failed: true,
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
  turn_failed: true,
};

const models: Record<IvyModel, true> = { terra: true, sol: true };
const workspaceStates: Record<WorkspaceToolsState, true> = {
  unavailable: true,
  available: true,
};

const components: Record<IvyComponent, true> = { assistant_message: true };
const segmentKinds: Record<IvyResponseSegment['kind'], true> = {
  commentary: true,
  final: true,
};
const kinds: Record<IvyPresentation['kind'], true> = {
  text: true,
  component: true,
  close_activity: true,
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

function text(value: unknown, bytes?: number): string {
  const result = boundedString(value, bytes ?? Infinity);
  if (!result.trim()) throw new DesktopContractError('malformed');
  return result;
}

export function decodeIvyRequest(value: unknown): IvyRequest {
  const data = record(value, ['version']);
  return { version: version(data['version']) };
}

export function decodeIvySelectRequest(value: unknown): IvySelectRequest {
  const data = record(value, ['version', 'model']);
  return {
    version: version(data['version']),
    model: variant(data['model'], models),
  };
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

export function decodeIvyQuestionReply(
  value: unknown,
): IvyQuestionReplyRequest {
  const data = record(value, ['version', 'prompt_id', 'action']);
  const action = data['action'];
  if (typeof action !== 'object' || action === null)
    throw new DesktopContractError('malformed');
  const kind = (action as Record<string, unknown>)['kind'];
  if (kind === 'answer') {
    const answer = record(action, ['kind', 'answer']);
    return {
      version: version(data['version']),
      prompt_id: text(data['prompt_id'], 512),
      action: { kind, answer: text(answer['answer'], 16384) },
    };
  }
  if (kind !== 'shown' && kind !== 'skip' && kind !== 'cancel')
    throw new DesktopContractError('unknown-variant');
  record(action, ['kind']);
  return {
    version: version(data['version']),
    prompt_id: text(data['prompt_id'], 512),
    action: { kind },
  };
}

function questions(value: unknown): IvyQuestion[] {
  if (!Array.isArray(value) || value.length > 5)
    throw new DesktopContractError('malformed');
  const rows: IvyQuestion[] = value.map((entry) => {
    const row = record(entry, [
      'id',
      'text',
      'choices',
      'multi_select',
      'shown',
      'answering',
    ]);
    const choices = row['choices'];
    if (
      !Array.isArray(choices) ||
      choices.length > 4 ||
      typeof row['multi_select'] !== 'boolean' ||
      typeof row['shown'] !== 'boolean' ||
      typeof row['answering'] !== 'boolean'
    )
      throw new DesktopContractError('malformed');
    return {
      id: text(row['id'], 512),
      text: text(row['text'], 32768),
      choices: choices.map((choice) => text(choice, 8192)),
      multi_select: row['multi_select'],
      shown: row['shown'],
      answering: row['answering'],
    };
  });
  if (new Set(rows.map((row) => row.id)).size !== rows.length)
    throw new DesktopContractError('malformed');
  return rows;
}

function presentation(value: unknown): IvyPresentation {
  if (typeof value !== 'object' || value === null)
    throw new DesktopContractError('malformed');
  const kind = variant((value as Record<string, unknown>)['kind'], kinds);
  if (kind === 'text') {
    const data = record(value, ['kind', 'text']);
    return { kind: 'text', text: text(data['text']) };
  }
  if (kind === 'close_activity') {
    record(value, ['kind']);
    return { kind };
  }
  const data = record(value, ['kind', 'component', 'title', 'body']);
  return {
    kind: 'component',
    component: variant(data['component'], components),
    title: text(data['title']),
    body: text(data['body']),
  };
}

const activityKinds: Record<IvyActivityKind, true> = {
  shell: true,
  web: true,
  file_read: true,
  file_write: true,
  mcp: true,
  skill: true,
  skill_create: true,
  memory: true,
  tool: true,
};
const activityStates: Record<IvyActivityState, true> = {
  running: true,
  completed: true,
  failed: true,
  finished: true,
};
const activityProviders: Record<IvyActivityProvider, true> = {
  chrome: true,
  stellar: true,
  github: true,
  calendar: true,
  spotify: true,
  mcp: true,
  local: true,
  web: true,
};
const activityOperations: Record<IvyActivityOperation, true> = {
  search: true,
  read: true,
  write: true,
  open: true,
  list: true,
  inspect: true,
  update: true,
  execute: true,
  call: true,
};
function activity(value: unknown): IvyActivity[] {
  if (!Array.isArray(value) || value.length > 12)
    throw new DesktopContractError('malformed');
  const result = value.map((row): IvyActivity => {
    const data = record(
      row,
      ['id', 'kind', 'state'],
      ['provider', 'operation'],
    );
    const id = boundedString(data['id'], 16);
    if (!/^[0-9a-f]{16}$/.test(id)) throw new DesktopContractError('malformed');
    return {
      id,
      kind: variant(data['kind'], activityKinds),
      state: variant(data['state'], activityStates),
      ...(Object.hasOwn(data, 'provider')
        ? { provider: variant(data['provider'], activityProviders) }
        : {}),
      ...(Object.hasOwn(data, 'operation')
        ? { operation: variant(data['operation'], activityOperations) }
        : {}),
    };
  });
  if (new Set(result.map((row) => row.id)).size !== result.length)
    throw new DesktopContractError('malformed');
  return result;
}

export function decodeIvySnapshot(value: unknown): IvySnapshot {
  const data = record(
    value,
    [
      'version',
      'revision',
      'turn_id',
      'model',
      'verified_model',
      'workspace_tools',
      'workspace_epoch',
      'connection',
      'turn',
      'items',
      'activity',
      'reset_id',
      'error',
    ],
    ['first_text_observed', 'questions', 'response_segments'],
  );
  if (
    Object.hasOwn(data, 'first_text_observed') &&
    data['first_text_observed'] !== true
  )
    throw new DesktopContractError('malformed');
  const items = data['items'];
  if (!Array.isArray(items) || items.length > 2)
    throw new DesktopContractError('malformed');
  const decoded = items.map(presentation);
  if (new Set(decoded.map((item) => item.kind)).size !== decoded.length)
    throw new DesktopContractError('malformed');
  if (decoded.filter((item) => item.kind !== 'text').length > 1)
    throw new DesktopContractError('malformed');
  const snapshot: IvySnapshot = {
    ...(Object.hasOwn(data, 'questions')
      ? { questions: questions(data['questions']) }
      : {}),
    ...(data['first_text_observed'] === true
      ? { first_text_observed: true }
      : {}),
    version: version(data['version']),
    revision: sequence(data['revision']),
    turn_id: data['turn_id'] === null ? null : identifier(data['turn_id']),
    model: variant(data['model'], models),
    verified_model:
      data['verified_model'] === null
        ? null
        : variant(data['verified_model'], models),
    workspace_tools: variant(data['workspace_tools'], workspaceStates),
    workspace_epoch: sequence(data['workspace_epoch']),
    connection: variant(data['connection'], connections),
    turn: variant(data['turn'], turns),
    items: decoded,
    response_segments: responseSegments(data['response_segments'] ?? []),
    activity: activity(data['activity']),
    reset_id: data['reset_id'] === null ? null : text(data['reset_id'], 128),
    error: data['error'] === null ? null : decodeIvyError(data['error']),
  };
  if (
    snapshot.verified_model !== null &&
    snapshot.verified_model !== snapshot.model
  )
    throw new DesktopContractError('malformed');
  return snapshot;
}

export function isSealedIvyProseLine(line: string): boolean {
  const content = line.replace(/^\p{White_Space}+/u, '');
  if (content.startsWith('[')) {
    // An unambiguous Markdown opener can continue onto the next line.
    const link = /^\[([^[\]{}"]+)\]\(/u.exec(content);
    return !!link && /\P{White_Space}/u.test(link[1]);
  }
  if (content.startsWith('<'))
    return /^<(?:https?:\/\/|mailto:)[^<>"\x60\p{White_Space}]+>/u.test(
      content,
    );
  if (content.startsWith('\x60')) {
    const code = /^\x60([^\x60]+)\x60/u.exec(content);
    return !!code && /^\p{White_Space}*[^<{[\p{White_Space}]/u.test(code[1]);
  }
  return !content.startsWith('{');
}

function responseSegments(value: unknown): IvyResponseSegment[] {
  if (!Array.isArray(value) || value.length > 17)
    throw new DesktopContractError('malformed');
  const rows = value.map((entry): IvyResponseSegment => {
    const row = record(entry, ['id', 'kind', 'text', 'sequence', 'reused']);
    const id = boundedString(row['id'], 64);
    if (!/^[0-9a-f]{64}$/.test(id) || typeof row['reused'] !== 'boolean')
      throw new DesktopContractError('malformed');
    const kind = variant(row['kind'], segmentKinds);
    const order = row['sequence'] === null ? null : sequence(row['sequence']);
    if ((kind === 'commentary') !== (order !== null))
      throw new DesktopContractError('malformed');
    const content = text(row['text'], kind === 'commentary' ? 4096 : undefined);
    if (
      !content.split('\n').every(isSealedIvyProseLine) ||
      /stellar_presentation|<\/?(?:think|analysis|tool_call)/i.test(content) ||
      /\p{Cc}/u.test(content.replace(/[\n\t\r]/gu, '')) ||
      (kind === 'commentary' && row['reused'])
    )
      throw new DesktopContractError('malformed');
    return { id, kind, text: content, sequence: order, reused: row['reused'] };
  });
  if (
    new Set(rows.map((row) => row.id)).size !== rows.length ||
    rows.filter((row) => row.kind === 'commentary').length > 16 ||
    rows.filter((row) => row.kind === 'final').length > 1 ||
    rows.some((row, index) => row.kind === 'final' && index !== rows.length - 1)
  )
    throw new DesktopContractError('malformed');
  return rows;
}
