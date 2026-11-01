import {
  appInfoCommand,
  appInfoEvent,
  decodeAppInfoError,
  decodeAppInfoEvent,
  decodeAppInfoReply,
  decodeAppInfoRequest,
  DesktopContractError,
  type AppInfoError,
  type AppInfoEvent,
  type AppInfoReply,
  type AppInfoRequest,
} from '@stellar/desktop-contracts';
import type { DesktopTransport } from './desktop-transport';

export class DesktopAdapterError extends Error {
  constructor(
    readonly kind: 'contract' | 'native' | 'transport' | 'disposed',
    readonly detail?: AppInfoError | DesktopContractError,
  ) {
    super(`Desktop adapter: ${kind}`);
  }
}

interface Subscription {
  active: boolean;
  unlisten?: () => void;
}

export class DesktopAdapter {
  private disposed = false;
  private readonly subscriptions = new Set<Subscription>();

  constructor(private readonly transport: DesktopTransport) {}

  async appInfo(input: AppInfoRequest): Promise<AppInfoReply> {
    this.assertActive();
    let request: AppInfoRequest;
    try {
      request = decodeAppInfoRequest(input);
    } catch (error) {
      throw this.contractError(error);
    }
    let payload: unknown;
    try {
      payload = await this.transport.invoke(appInfoCommand, { request });
    } catch (error) {
      this.assertActive();
      let detail: AppInfoError;
      try {
        detail = decodeAppInfoError(error);
      } catch {
        throw new DesktopAdapterError('transport');
      }
      throw new DesktopAdapterError('native', detail);
    }
    this.assertActive();
    try {
      const reply = decodeAppInfoReply(payload);
      if (reply.sequence !== request.sequence)
        throw new DesktopContractError('malformed');
      return reply;
    } catch (error) {
      throw this.contractError(error);
    }
  }

  async subscribe(
    callback: (event: AppInfoEvent) => void,
    onError: (error: DesktopAdapterError) => void,
  ): Promise<() => void> {
    this.assertActive();
    const entry: Subscription = { active: true };
    const stop = () => {
      if (!entry.active) return;
      entry.active = false;
      this.subscriptions.delete(entry);
      try {
        entry.unlisten?.();
      } catch {
        throw new DesktopAdapterError('transport');
      }
    };
    this.subscriptions.add(entry);
    try {
      const unlisten = await this.transport.listen(appInfoEvent, (payload) => {
        if (!entry.active || this.disposed) return;
        let event: AppInfoEvent;
        try {
          event = decodeAppInfoEvent(payload);
        } catch (error) {
          onError(this.contractError(error));
          return;
        }
        callback(event);
      });
      if (typeof unlisten !== 'function')
        throw new DesktopAdapterError('transport');
      if (!entry.active || this.disposed) unlisten();
      else entry.unlisten = unlisten;
      return stop;
    } catch {
      stop();
      this.assertActive();
      throw new DesktopAdapterError('transport');
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    let failed = false;
    for (const entry of this.subscriptions) {
      entry.active = false;
      try {
        entry.unlisten?.();
      } catch {
        failed = true;
      }
    }
    this.subscriptions.clear();
    if (failed) throw new DesktopAdapterError('transport');
  }

  private assertActive(): void {
    if (this.disposed) throw new DesktopAdapterError('disposed');
  }
  private contractError(error: unknown): DesktopAdapterError {
    return new DesktopAdapterError(
      'contract',
      error instanceof DesktopContractError
        ? error
        : new DesktopContractError('malformed'),
    );
  }
}
