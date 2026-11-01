import type {
  CaptureState,
  ProbeError,
  ProbeEvent,
  ProbeReply,
  ProbeRequest,
} from './generated/contracts.js';

type NativeBridge = {
  core: {
    invoke: <T>(
      command: string,
      arguments_: Record<string, unknown>,
    ) => Promise<T>;
  };
  event: {
    listen: (
      name: string,
      callback: (event: { payload: unknown }) => void,
    ) => Promise<() => void>;
  };
};

declare global {
  interface Window {
    __TAURI__?: NativeBridge;
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Incompatible native payload');
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error('Unknown native field');
}

function decodeState(value: unknown): CaptureState {
  const state = object(value);
  if (state.kind === 'idle') {
    exact(state, ['kind']);
    return { kind: 'idle' };
  }
  if (
    state.kind === 'active' &&
    typeof state.rms === 'number' &&
    Number.isFinite(state.rms) &&
    state.rms >= 0 &&
    state.rms <= 1
  ) {
    exact(state, ['kind', 'rms']);
    return { kind: 'active', rms: state.rms };
  }
  throw new Error('Unknown or invalid native capture state');
}

export function decodeReply(value: unknown): ProbeReply {
  const reply = object(value);
  exact(reply, [
    'version',
    'sequence',
    'device_label',
    'state',
    'sound_active',
  ]);
  if (
    reply.version !== 1 ||
    typeof reply.sequence !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(reply.sequence) ||
    BigInt(reply.sequence) > 18446744073709551615n ||
    typeof reply.sound_active !== 'boolean'
  )
    throw new Error('Incompatible native reply');
  if (
    reply.device_label !== undefined &&
    (typeof reply.device_label !== 'string' ||
      new TextEncoder().encode(reply.device_label).length > 80)
  )
    throw new Error('Invalid native optional label');
  return {
    version: 1,
    sequence: reply.sequence,
    state: decodeState(reply.state),
    sound_active: reply.sound_active,
    ...(reply.device_label === undefined
      ? {}
      : { device_label: reply.device_label as string }),
  };
}

export function decodeError(value: unknown): ProbeError {
  const error = object(value);
  if (
    error.code === 'unsupported_version' &&
    typeof error.received === 'number' &&
    Number.isInteger(error.received) &&
    error.received >= 0 &&
    error.received <= 65535
  ) {
    exact(error, ['code', 'received']);
    return { code: 'unsupported_version', received: error.received };
  }
  if (
    error.code === 'invalid_sequence' ||
    error.code === 'invalid_level' ||
    error.code === 'label_too_long' ||
    error.code === 'event_unavailable'
  ) {
    exact(error, ['code']);
    return { code: error.code };
  }
  throw new Error('Unrecognized native error');
}

export function describeError(error: ProbeError): string {
  switch (error.code) {
    case 'unsupported_version':
      return `Unsupported version ${error.received}`;
    case 'invalid_sequence':
      return 'Invalid sequence';
    case 'invalid_level':
      return 'Invalid level';
    case 'label_too_long':
      return 'Label too long';
    case 'event_unavailable':
      return 'Event unavailable';
    default: {
      const exhaustive: never = error;
      return exhaustive;
    }
  }
}

export function nativeAdapter() {
  const bridge = window.__TAURI__;
  if (!bridge) throw new Error('Open this probe in the native Tauri window');
  return {
    async roundTrip(request: ProbeRequest): Promise<ProbeReply> {
      let result: unknown;
      try {
        result = await bridge.core.invoke<unknown>('probe_round_trip', {
          request,
        });
      } catch (error) {
        throw decodeError(error);
      }
      return decodeReply(result);
    },
    listen: (callback: (event: ProbeEvent) => void) =>
      bridge.event.listen('contract-observed', ({ payload }) => {
        const event = object(payload);
        exact(event, ['version', 'reply']);
        if (event.version !== 1) throw new Error('Incompatible native event');
        callback({ version: 1, reply: decodeReply(event.reply) });
      }),
  };
}
