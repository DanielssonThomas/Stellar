import type { ActivitySummaryPayload } from '@stellar/ui-molecules';
import {
  boundedJson,
  canonicalJson,
  plainRecord,
  freezeJson,
} from './stage-json';

export type Surface<P extends object> = Extract<keyof P, string>;
export type Decoders<P extends object> = {
  readonly [K in keyof P]: (value: unknown) => P[K] | null;
};
export type Prominence = 'primary' | 'secondary';
type Shared = {
  readonly contractVersion: 1;
  readonly commandId: number;
  readonly instanceId: string;
};
type PayloadCommand<P extends object> = {
  [K in Surface<P>]:
    | (Shared & {
        readonly action: 'open';
        readonly surface: K;
        readonly payload: P[K];
        readonly prominence: Prominence;
      })
    | (Shared & {
        readonly action: 'update';
        readonly surface: K;
        readonly payload: P[K];
      });
}[Surface<P>];
export type StageCommand<P extends object> =
  | PayloadCommand<P>
  | (Shared & { readonly action: 'focus' | 'minimize' | 'close' });
export type StageInstance<P extends object> = {
  [K in Surface<P>]: {
    readonly instanceId: string;
    readonly surface: K;
    readonly payload: P[K];
    readonly prominence: Prominence;
    readonly minimized: boolean;
  };
}[Surface<P>];
export type StageResult = {
  readonly status: 'applied' | 'duplicate' | 'rejected';
  readonly reason?: string;
  readonly action?: 'open' | 'update' | 'focus' | 'minimize' | 'close';
  readonly instanceId?: string;
};
export type { ActivitySummaryPayload } from '@stellar/ui-molecules';
export type ProductionPayloadMap = {
  readonly 'activity-summary': ActivitySummaryPayload;
  readonly 'assistant-message': {
    readonly title: string;
    readonly body: string;
  };
};

export function decodeAssistantMessage(
  value: unknown,
): ProductionPayloadMap['assistant-message'] | null {
  if (!plainRecord(value) || !exactKeys(value, ['title', 'body'])) return null;
  const title = value['title'],
    body = value['body'];
  const encoder = new TextEncoder();
  if (
    typeof title !== 'string' ||
    !title.trim() ||
    encoder.encode(title).length > 160 ||
    typeof body !== 'string' ||
    !body.trim() ||
    encoder.encode(body).length > 8192 ||
    [...(title + body)].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return (
        (code < 32 && ![9, 10, 13].includes(code)) ||
        code === 127 ||
        (code >= 0xd800 && code <= 0xdfff)
      );
    })
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
      !plainRecord(input) ||
      !boundedJson(
        input,
        input['surface'] === 'assistant-message' ? 24576 : 4096,
      )
    )
      return null;
    const { contractVersion, commandId, instanceId, action } = input;
    if (
      contractVersion !== 1 ||
      typeof commandId !== 'number' ||
      !Number.isSafeInteger(commandId) ||
      commandId < 1 ||
      typeof instanceId !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(instanceId)
    )
      return null;
    const shared = { contractVersion: 1 as const, commandId, instanceId };
    const keys = ['contractVersion', 'commandId', 'instanceId', 'action'];
    if (action === 'focus' || action === 'minimize' || action === 'close')
      return exactKeys(input, keys)
        ? Object.freeze({ ...shared, action })
        : null;
    if (action !== 'open' && action !== 'update') return null;
    if (
      !exactKeys(input, [
        ...keys,
        'surface',
        'payload',
        ...(action === 'open' ? ['prominence'] : []),
      ])
    )
      return null;
    if (
      typeof input['surface'] !== 'string' ||
      !Object.hasOwn(decoders, input['surface']) ||
      !boundedJson(
        input['payload'],
        input['surface'] === 'assistant-message' ? 20480 : 2048,
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
        input['surface'] === 'assistant-message' ? 20480 : 2048,
      )
    )
      return null;
    const detached = freezeJson(JSON.parse(canonicalJson(payload)));
    return Object.freeze({
      ...shared,
      action,
      surface: input['surface'],
      payload: detached,
      ...(action === 'open' ? { prominence: input['prominence'] } : {}),
    }) as StageCommand<P>;
  } catch {
    return null;
  }
}
