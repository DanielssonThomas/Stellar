import type { ActivitySummaryPayload } from '@stellar/ui-molecules';
import type {
  WorkspaceChartPayload,
  WorkspaceIssuePayload,
} from '@stellar/desktop-contracts';
import type {
  PresentationTextPayload,
  PresentationMediaPayload,
  PresentationDiagramPayload,
  PresentationTelemetryPayload,
} from '@stellar/ui-molecules';
import {
  boundedJson,
  canonicalJson,
  plainRecord,
  freezeJson,
} from './stage-json';
import { chartJsonAllowance } from './stage-chart-budget';

export type Surface<P extends object> = Extract<keyof P, string>;
export type Decoders<P extends object> = {
  readonly [K in keyof P]: (value: unknown) => P[K] | null;
};
export type Prominence = 'primary' | 'secondary';
type Shared = {
  readonly contractVersion: 1;
  readonly commandId: number;
};
type InstanceShared = Shared & {
  readonly instanceId: string;
};
type PayloadCommand<P extends object> = {
  [K in Surface<P>]:
    | (InstanceShared & {
        readonly action: 'open';
        readonly surface: K;
        readonly payload: P[K];
        readonly prominence: Prominence;
      })
    | (InstanceShared & {
        readonly action: 'update';
        readonly surface: K;
        readonly payload: P[K];
        readonly expectedRevision?: number;
      });
}[Surface<P>];
export type StageCommand<P extends object> =
  | PayloadCommand<P>
  | (InstanceShared & {
      readonly action: 'focus' | 'minimize' | 'restore' | 'maximize' | 'close';
    })
  | (InstanceShared & { readonly action: 'resize'; readonly percent: number })
  | (InstanceShared & { readonly action: 'swap'; readonly otherId: string })
  | (Shared & { readonly action: 'clear' })
  | (Shared & { readonly action: 'restore-layout' })
  | (Shared & {
      readonly action: 'arrange';
      readonly instanceIds: readonly string[];
    });
export type StageInstance<P extends object> = {
  [K in Surface<P>]: {
    readonly instanceId: string;
    readonly surface: K;
    readonly payload: P[K];
    readonly prominence: Prominence;
    readonly minimized: boolean;
    readonly revision: number;
    readonly userEdited: boolean;
  };
}[Surface<P>];
export type StageResult = {
  readonly status: 'applied' | 'duplicate' | 'rejected';
  readonly reason?: string;
  readonly action?:
    | 'open'
    | 'update'
    | 'focus'
    | 'minimize'
    | 'close'
    | 'clear'
    | 'arrange'
    | 'swap'
    | 'resize'
    | 'restore'
    | 'maximize'
    | 'restore-layout';
  readonly instanceId?: string;
};
export type { ActivitySummaryPayload } from '@stellar/ui-molecules';
export type ProductionPayloadMap = {
  readonly 'github-issue': WorkspaceIssuePayload;
  readonly chart: WorkspaceChartPayload;
  readonly 'rich-text': PresentationTextPayload;
  readonly image: Extract<PresentationMediaPayload, { kind: 'image' }>;
  readonly browser: Extract<PresentationMediaPayload, { kind: 'browser' }>;
  readonly diagram: PresentationDiagramPayload;
  readonly workflow: PresentationTelemetryPayload & { kind: 'workflow' };
  readonly session: PresentationTelemetryPayload & { kind: 'session' };
  readonly 'activity-summary': ActivitySummaryPayload;
  readonly 'assistant-message': {
    readonly title: string;
    readonly body: string;
  };
};

function payloadLimit(surface: unknown): number {
  switch (surface) {
    case 'assistant-message':
      return Infinity;
    case 'rich-text':
      return 65536;
    case 'image':
      return 512 * 1024 + 6144;
    case 'diagram':
    case 'chart':
    case 'github-issue':
      return 16384;
    case 'browser':
      return 4096;
    default:
      return 2048;
  }
}

function readableText(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (
      (code < 32 && ![9, 10, 13].includes(code)) ||
      code === 127 ||
      (code >= 0xd800 && code <= 0xdfff)
    )
      return false;
  }
  return true;
}

export function decodeAssistantMessage(
  value: unknown,
): ProductionPayloadMap['assistant-message'] | null {
  if (!plainRecord(value) || !exactKeys(value, ['title', 'body'])) return null;
  const title = value['title'],
    body = value['body'];
  if (
    typeof title !== 'string' ||
    !title.trim() ||
    typeof body !== 'string' ||
    !body.trim() ||
    !readableText(title) ||
    !readableText(body)
  )
    return null;
  return Object.freeze({ title, body });
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every(
      (key) => required.includes(key) || optional.includes(key),
    )
  );
}

export function decodeActivitySummary(
  value: unknown,
): ActivitySummaryPayload | null {
  if (
    !plainRecord(value) ||
    !exactKeys(value, ['durationMs', 'peakLevel'], ['inputLabel'])
  )
    return null;
  if (
    typeof value['durationMs'] !== 'number' ||
    !Number.isFinite(value['durationMs']) ||
    value['durationMs'] < 0 ||
    value['durationMs'] > 86400000
  )
    return null;
  if (
    typeof value['peakLevel'] !== 'number' ||
    !Number.isFinite(value['peakLevel']) ||
    value['peakLevel'] < 0 ||
    value['peakLevel'] > 1
  )
    return null;
  if (
    Object.hasOwn(value, 'inputLabel') &&
    (typeof value['inputLabel'] !== 'string' ||
      value['inputLabel'].length < 1 ||
      value['inputLabel'].length > 80 ||
      [...value['inputLabel']].some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ))
  )
    return null;
  return Object.freeze({
    durationMs: value['durationMs'],
    peakLevel: value['peakLevel'],
    ...(typeof value['inputLabel'] === 'string'
      ? { inputLabel: value['inputLabel'] }
      : {}),
  });
}

export function decodeStageCommand<P extends object>(
  input: unknown,
  decoders: Decoders<P>,
): StageCommand<P> | null {
  try {
    if (
      plainRecord(input) &&
      input['action'] === 'arrange' &&
      Array.isArray(input['instanceIds']) &&
      Object.getPrototypeOf(input['instanceIds']) !== Array.prototype
    )
      return null;
    if (
      !plainRecord(input) ||
      !boundedJson(
        input,
        payloadLimit(input['surface']) + 1024,
        chartJsonAllowance(input['surface'], input['payload']),
      )
    )
      return null;
    const { contractVersion, commandId, instanceId, action } = input;
    if (
      contractVersion !== 1 ||
      typeof commandId !== 'number' ||
      !Number.isSafeInteger(commandId) ||
      commandId < 1
    )
      return null;
    const workspaceShared = { contractVersion: 1 as const, commandId };
    const workspaceKeys = ['contractVersion', 'commandId', 'action'];
    if (action === 'clear' || action === 'restore-layout')
      return exactKeys(input, workspaceKeys)
        ? Object.freeze({ ...workspaceShared, action })
        : null;
    if (action === 'arrange') {
      const ids = input['instanceIds'];
      if (
        !exactKeys(input, [...workspaceKeys, 'instanceIds']) ||
        !Array.isArray(ids) ||
        ids.length > 4 ||
        !ids.every(
          (id) => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(id),
        ) ||
        new Set(ids).size !== ids.length
      )
        return null;
      return Object.freeze({
        ...workspaceShared,
        action,
        instanceIds: Object.freeze([...ids]),
      });
    }
    if (
      typeof instanceId !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(instanceId)
    )
      return null;
    const shared = { ...workspaceShared, instanceId };
    const keys = ['contractVersion', 'commandId', 'instanceId', 'action'];
    if (
      action === 'focus' ||
      action === 'minimize' ||
      action === 'close' ||
      action === 'restore' ||
      action === 'maximize'
    )
      return exactKeys(input, keys)
        ? Object.freeze({ ...shared, action })
        : null;
    if (action === 'resize')
      return exactKeys(input, [...keys, 'percent']) &&
        typeof input['percent'] === 'number' &&
        Number.isFinite(input['percent']) &&
        input['percent'] >= 10 &&
        input['percent'] <= 90
        ? { ...shared, action, percent: input['percent'] }
        : null;
    if (action === 'swap')
      return exactKeys(input, [...keys, 'otherId']) &&
        typeof input['otherId'] === 'string' &&
        /^[a-zA-Z0-9_-]{1,64}$/.test(input['otherId']) &&
        input['otherId'] !== instanceId
        ? { ...shared, action, otherId: input['otherId'] }
        : null;
    if (action !== 'open' && action !== 'update') return null;
    if (
      !exactKeys(
        input,
        [
          ...keys,
          'surface',
          'payload',
          ...(action === 'open' ? ['prominence'] : []),
        ],
        action === 'update' ? ['expectedRevision'] : [],
      )
    )
      return null;
    if (
      action === 'update' &&
      Object.hasOwn(input, 'expectedRevision') &&
      (!Number.isSafeInteger(input['expectedRevision']) ||
        Number(input['expectedRevision']) < 0)
    )
      return null;
    if (
      typeof input['surface'] !== 'string' ||
      !Object.hasOwn(decoders, input['surface']) ||
      !boundedJson(
        input['payload'],
        payloadLimit(input['surface']),
        chartJsonAllowance(input['surface'], input['payload']),
      )
    )
      return null;
    if (
      action === 'open' &&
      input['prominence'] !== 'primary' &&
      input['prominence'] !== 'secondary'
    )
      return null;
    const decode = decoders[input['surface'] as Surface<P>];
    const payload = decode(input['payload']);
    if (
      payload === null ||
      !boundedJson(
        payload,
        payloadLimit(input['surface']),
        chartJsonAllowance(input['surface'], payload),
      )
    )
      return null;
    const detached = freezeJson(JSON.parse(canonicalJson(payload)));
    return Object.freeze({
      ...shared,
      action,
      surface: input['surface'],
      payload: detached,
      ...(action === 'update' && Object.hasOwn(input, 'expectedRevision')
        ? { expectedRevision: input['expectedRevision'] }
        : {}),
      ...(action === 'open' ? { prominence: input['prominence'] } : {}),
    }) as StageCommand<P>;
  } catch {
    return null;
  }
}
