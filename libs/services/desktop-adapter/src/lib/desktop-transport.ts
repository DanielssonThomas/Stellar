import {
  appInfoCommand,
  appInfoEvent,
  decodeAppInfoRequest,
  type AppInfoReply,
  type AppInfoRequest,
  type DesktopCommands,
} from '@stellar/desktop-contracts';

export interface DesktopTransport {
  invoke(
    command: typeof appInfoCommand,
    args: { request: DesktopCommands[typeof appInfoCommand]['request'] },
  ): Promise<unknown>;
  listen(
    event: typeof appInfoEvent,
    callback: (payload: unknown) => void,
  ): Promise<() => void>;
}

export interface NativeDesktopApi {
  core: {
    invoke(
      command: string,
      args: { request: AppInfoRequest },
    ): Promise<unknown>;
  };
  event: {
    listen(
      event: string,
      callback: (event: { payload: unknown }) => void,
    ): Promise<() => void>;
  };
}

export function createNativeDesktopTransport(
  api: NativeDesktopApi,
): DesktopTransport {
  return {
    invoke: (command, args) => api.core.invoke(command, args),
    listen: (event, callback) =>
      api.event.listen(event, (envelope) => callback(envelope.payload)),
  };
}

export function createBrowserDesktopTransport(): DesktopTransport {
  const listeners = new Set<(payload: unknown) => void>();
  return {
    async invoke(_command, args) {
      const request = decodeAppInfoRequest(args.request);
      const reply: AppInfoReply = {
        ...request,
        application: 'stellar-desktop',
        capabilities: [],
        build_revision: null,
      };
      for (const listener of [...listeners])
        if (listeners.has(listener)) listener({ version: 1, info: reply });
      return reply;
    },
    async listen(_event, callback) {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
  };
}
