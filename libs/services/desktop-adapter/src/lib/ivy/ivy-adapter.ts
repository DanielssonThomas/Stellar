import {
  decodeIvyError,
  decodeIvyRequest,
  decodeIvySnapshot,
  decodeIvySubmitRequest,
  ivyEvent,
  ivyConnectCommand,
  ivySnapshotCommand,
  ivySubmitCommand,
  ivyCancelCommand,
  ivyReconcileCommand,
  ivyDisconnectCommand,
  type IvyCommands,
  type IvyErrorCode,
  type IvySnapshot,
} from '@stellar/desktop-contracts';
import type { IvyTransport } from './ivy-transport';

export class IvyAdapterError extends Error {
  constructor(
    readonly kind: 'contract' | 'transport' | 'native' | 'disposed',
    readonly code?: IvyErrorCode,
  ) {
    super('Ivy adapter: ' + kind);
  }
}

interface Subscription {
  active: boolean;
  unlisten?: () => void;
}
const commands: Record<keyof IvyCommands, true> = {
  [ivyConnectCommand]: true,
  [ivySnapshotCommand]: true,
  [ivySubmitCommand]: true,
  [ivyCancelCommand]: true,
  [ivyReconcileCommand]: true,
  [ivyDisconnectCommand]: true,
};

export class IvyAdapter {
  private disposed = false;
  private subscriptions = new Set<Subscription>();
  constructor(private readonly transport: IvyTransport) {}

  async request<K extends keyof IvyCommands>(
    command: K,
    input: IvyCommands[K],
  ): Promise<IvySnapshot> {
    this.assertActive();
    let request: IvyCommands[K];
    try {
      if (!Object.hasOwn(commands, command)) throw new Error();
      request = (
        command === ivySubmitCommand
          ? decodeIvySubmitRequest(input)
          : decodeIvyRequest(input)
      ) as IvyCommands[K];
    } catch {
      throw new IvyAdapterError('contract');
    }
    let payload: unknown;
    try {
      payload = await this.transport.invoke(command, { request });
    } catch (error) {
      this.assertActive();
      let code: IvyErrorCode;
      try {
        code = decodeIvyError(error);
      } catch {
        throw new IvyAdapterError('transport');
      }
      throw new IvyAdapterError('native', code);
    }
    this.assertActive();
    try {
      return decodeIvySnapshot(payload);
    } catch {
      throw new IvyAdapterError('contract');
    }
  }

  async subscribe(
    callback: (snapshot: IvySnapshot) => void,
    onError: (error: IvyAdapterError) => void,
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
        throw new IvyAdapterError('transport');
      }
    };
    this.subscriptions.add(entry);
    try {
      const unlisten = await this.transport.listen(ivyEvent, (payload) => {
        if (!entry.active || this.disposed) return;
        let snapshot: IvySnapshot;
        try {
          snapshot = decodeIvySnapshot(payload);
        } catch {
          onError(new IvyAdapterError('contract'));
          return;
        }
        callback(snapshot);
      });
      if (typeof unlisten !== 'function')
        throw new IvyAdapterError('transport');
      if (!entry.active || this.disposed) unlisten();
      else entry.unlisten = unlisten;
      return stop;
    } catch {
      stop();
      this.assertActive();
      throw new IvyAdapterError('transport');
    }
  }

  dispose() {
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
    if (failed) throw new IvyAdapterError('transport');
  }
  private assertActive() {
    if (this.disposed) throw new IvyAdapterError('disposed');
  }
}
