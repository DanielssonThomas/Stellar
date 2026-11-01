import type {
  AppCapability,
  AppInfoError,
  AppInfoEvent,
  AppInfoReply,
  AppInfoRequest,
} from '../generated';

export class DesktopContractError extends Error {
  constructor(
    readonly kind: 'malformed' | 'unsupported-version' | 'unknown-variant',
  ) {
    super(`Desktop contract: ${kind}`);
  }
}

function record(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new DesktopContractError('malformed');
  const result = value as Record<string, unknown>;
  if (
    required.some((key) => !Object.hasOwn(result, key)) ||
    Object.keys(result).some(
      (key) => !required.includes(key) && !optional.includes(key),
    )
  )
    throw new DesktopContractError('malformed');
  return result;
}

function version(value: unknown): 1 {
  if (
    !Number.isInteger(value) ||
    typeof value !== 'number' ||
    value < 0 ||
    value > 65535
  )
    throw new DesktopContractError('malformed');
  if (value !== 1) throw new DesktopContractError('unsupported-version');
  return value;
}

function boundedString(value: unknown, bytes: number): string {
  if (
    typeof value !== 'string' ||
    value.length > bytes ||
    new TextEncoder().encode(value).length > bytes
  )
    throw new DesktopContractError('malformed');
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (character.length === 1 && code >= 0xd800 && code <= 0xdfff)
      throw new DesktopContractError('malformed');
  }
  return value;
}

function sequence(value: unknown): string {
  const result = boundedString(value, 20);
  if (
    !/^(0|[1-9][0-9]{0,19})$/.test(result) ||
    BigInt(result) > 18446744073709551615n
  )
    throw new DesktopContractError('malformed');
  return result;
}

export function decodeAppInfoRequest(value: unknown): AppInfoRequest {
  const data = record(value, ['version', 'sequence'], ['label']);
  const label =
    data['label'] == null ? undefined : boundedString(data['label'], 80);
  return {
    version: version(data['version']),
    sequence: sequence(data['sequence']),
    ...(label === undefined ? {} : { label }),
  };
}

function capability(value: unknown): AppCapability {
  const data = record(value, ['kind']);
  switch (data['kind']) {
    case 'native_window':
      return { kind: 'native_window' };
    case 'contract_events':
      return { kind: 'contract_events' };
    default:
      throw new DesktopContractError('unknown-variant');
  }
}

export function decodeAppInfoReply(value: unknown): AppInfoReply {
  const data = record(
    value,
    ['version', 'sequence', 'application', 'capabilities', 'build_revision'],
    ['label'],
  );
  if (
    data['application'] !== 'stellar-desktop' ||
    !Array.isArray(data['capabilities']) ||
    data['capabilities'].length > 2
  )
    throw new DesktopContractError('malformed');
  const capabilities = data['capabilities'].map(capability);
  if (
    new Set(capabilities.map((value) => value.kind)).size !==
    capabilities.length
  )
    throw new DesktopContractError('malformed');
  const label = Object.hasOwn(data, 'label')
    ? boundedString(data['label'], 80)
    : undefined;
  return {
    version: version(data['version']),
    sequence: sequence(data['sequence']),
    application: data['application'],
    capabilities,
    build_revision:
      data['build_revision'] === null
        ? null
        : boundedString(data['build_revision'], 80),
    ...(label === undefined ? {} : { label }),
  };
}

export function decodeAppInfoEvent(value: unknown): AppInfoEvent {
  const data = record(value, ['version', 'info']);
  return {
    version: version(data['version']),
    info: decodeAppInfoReply(data['info']),
  };
}

export function decodeAppInfoError(value: unknown): AppInfoError {
  const data = record(
    value,
    ['code'],
    typeof value === 'object' &&
      value !== null &&
      (value as Record<string, unknown>)['code'] === 'unsupported_version'
      ? ['received']
      : [],
  );
  switch (data['code']) {
    case 'malformed_request':
      return { code: 'malformed_request' };
    case 'unsupported_version': {
      const received = data['received'];
      if (
        typeof received !== 'number' ||
        !Number.isInteger(received) ||
        received < 0 ||
        received > 65535
      )
        throw new DesktopContractError('malformed');
      return { code: 'unsupported_version', received };
    }
    case 'invalid_sequence':
      return { code: 'invalid_sequence' };
    case 'label_too_long':
      return { code: 'label_too_long' };
    case 'event_unavailable':
      return { code: 'event_unavailable' };
    default:
      throw new DesktopContractError('unknown-variant');
  }
}
