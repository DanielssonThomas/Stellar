import {
  musicEvent,
  musicSetEnabledCommand,
  type MusicRequest,
} from '@stellar/desktop-contracts';

export interface MusicTransport {
  setEnabled(request: MusicRequest): Promise<unknown>;
  listen(callback: (payload: unknown) => void): Promise<() => void>;
}
export interface MusicNativeApi {
  core: {
    invoke(command: string, args: { request: MusicRequest }): Promise<unknown>;
  };
  event: {
    listen(
      event: string,
      callback: (event: { payload: unknown }) => void,
    ): Promise<() => void>;
  };
}
export function musicTransport(api?: MusicNativeApi): MusicTransport {
  return {
    setEnabled: async (request) => {
      if (!api) throw new Error('unavailable');
      return api.core.invoke(musicSetEnabledCommand, { request });
    },
    listen: async (callback) =>
      api
        ? api.event.listen(musicEvent, (event) => callback(event.payload))
        : () => undefined,
  };
}
