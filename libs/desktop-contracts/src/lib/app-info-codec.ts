import type {
  AppCapability,
  AppInfoError,
  AppInfoEvent,
  AppInfoReply,
  AppInfoRequest,
} from '../generated';

import {
  record,
  version,
  boundedString,
  sequence,
  DesktopContractError,
} from './wire-validation';
export { DesktopContractError } from './wire-validation';

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
