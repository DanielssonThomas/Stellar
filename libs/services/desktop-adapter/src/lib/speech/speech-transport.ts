import {
  speechEvent,
  type SpeechCommands,
  type SpeechSnapshot,
} from '@stellar/desktop-contracts';

export interface SpeechTransport {
  invoke<K extends keyof SpeechCommands>(
    command: K,
    args: { request: SpeechCommands[K] },
  ): Promise<unknown>;
  listen(
    event: typeof speechEvent,
    callback: (payload: unknown) => void,
  ): Promise<() => void>;
}

export interface SpeechNativeApi {
  core: {
    invoke(
      command: string,
      args: { request: SpeechCommands[keyof SpeechCommands] },
    ): Promise<unknown>;
  };
  event: {
    listen(
      event: string,
      callback: (event: { payload: unknown }) => void,
    ): Promise<() => void>;
  };
}

export function nativeSpeechTransport(api: SpeechNativeApi): SpeechTransport {
  return {
    invoke: (command, args) => api.core.invoke(command, args),
    listen: (event, callback) =>
      api.event.listen(event, (envelope) => callback(envelope.payload)),
  };
}

export function initialSpeechSnapshot(): SpeechSnapshot {
  return {
    version: 1,
    revision: '0',
    operation_id: null,
    state: 'idle',
    error: null,
  };
}

export function browserSpeechTransport(): SpeechTransport {
  return {
    async invoke() {
      throw 'unavailable';
    },
    async listen() {
      return () => undefined;
    },
  };
}
