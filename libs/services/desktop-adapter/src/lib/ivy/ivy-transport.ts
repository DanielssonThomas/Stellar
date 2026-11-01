import {
  ivyEvent,
  type IvyCommands,
  type IvySnapshot,
} from '@stellar/desktop-contracts';

export interface IvyTransport {
  invoke<K extends keyof IvyCommands>(
    command: K,
    args: { request: IvyCommands[K] },
  ): Promise<unknown>;
  listen(
    event: typeof ivyEvent,
    callback: (payload: unknown) => void,
  ): Promise<() => void>;
}

export interface IvyNativeApi {
  core: {
    invoke(
      command: string,
      args: { request: IvyCommands[keyof IvyCommands] },
    ): Promise<unknown>;
  };
  event: {
    listen(
      event: string,
      callback: (event: { payload: unknown }) => void,
    ): Promise<() => void>;
  };
}

export function nativeIvyTransport(api: IvyNativeApi): IvyTransport {
  return {
    invoke: (command, args) => api.core.invoke(command, args),
    listen: (event, callback) =>
      api.event.listen(event, (envelope) => callback(envelope.payload)),
  };
}

export function initialIvySnapshot(): IvySnapshot {
  return {
    version: 1,
    revision: '0',
    turn_id: null,
    connection: 'disconnected',
    turn: 'idle',
    items: [],
    error: null,
  };
}

export function browserIvyTransport(): IvyTransport {
  return {
    async invoke() {
      return {
        ...initialIvySnapshot(),
        revision: '1',
        connection: 'unavailable',
        error: 'unavailable',
      } satisfies IvySnapshot;
    },
    async listen() {
      return () => undefined;
    },
  };
}
