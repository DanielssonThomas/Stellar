import {
  DestroyRef,
  Injectable,
  InjectionToken,
  inject,
  signal,
} from '@angular/core';
import {
  ivyConnectCommand,
  ivySubmitCommand,
  ivyCancelCommand,
  ivyReconcileCommand,
  ivyDisconnectCommand,
  type IvyCommands,
  type IvySnapshot,
} from '@stellar/desktop-contracts';
import { IvyAdapter, IvyAdapterError } from '../ivy/ivy-adapter';
import {
  browserIvyTransport,
  nativeIvyTransport,
  initialIvySnapshot,
  type IvyNativeApi,
  type IvyTransport,
} from '../ivy/ivy-transport';

export const IVY_TRANSPORT = new InjectionToken<IvyTransport>('IvyTransport', {
  providedIn: 'root',
  factory: () => {
    const api = (globalThis as typeof globalThis & { __TAURI__?: IvyNativeApi })
      .__TAURI__;
    return api ? nativeIvyTransport(api) : browserIvyTransport();
  },
});

@Injectable({ providedIn: 'root' })
export class IvyAdapterService {
  private readonly adapter = new IvyAdapter(inject(IVY_TRANSPORT));
  private readonly current = signal(initialIvySnapshot());
  readonly state = this.current.asReadonly();
  private highestRevision = -1n;
  private disposed = false;
  private subscription?: Promise<() => void>;
  private connecting?: Promise<IvySnapshot>;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.disposed = true;
      try {
        this.adapter.dispose();
      } catch {
        /* Other native resources are independently released on app shutdown. */
      }
    });
  }

  connect(): Promise<IvySnapshot> {
    if (this.connecting) return this.connecting;
    const pending = this.listen().then(() =>
      this.invoke(ivyConnectCommand, { version: 1 }),
    );
    this.connecting = pending;
    const clear = () => {
      if (this.connecting === pending) this.connecting = undefined;
    };
    void pending.then(clear, clear);
    return pending;
  }
  submit(text: string, inputId: string) {
    return this.invoke(ivySubmitCommand, {
      version: 1,
      text,
      input_id: inputId,
    });
  }
  cancel() {
    return this.invoke(ivyCancelCommand, { version: 1 });
  }
  reconcile() {
    return this.invoke(ivyReconcileCommand, { version: 1 });
  }
  disconnect() {
    return this.invoke(ivyDisconnectCommand, { version: 1 });
  }

  private listen(): Promise<() => void> {
    if (!this.subscription) {
      const pending = this.adapter.subscribe(
        (snapshot) => this.accept(snapshot),
        (error) => this.failed(error),
      );
      this.subscription = pending;
      void pending.catch(() => {
        if (this.subscription === pending) this.subscription = undefined;
      });
    }
    return this.subscription;
  }
  private async invoke<K extends keyof IvyCommands>(
    command: K,
    request: IvyCommands[K],
  ): Promise<IvySnapshot> {
    try {
      const snapshot = await this.adapter.request(command, request);
      this.accept(snapshot);
      return this.current();
    } catch (error) {
      if (!this.disposed) this.failed(error);
      throw error;
    }
  }
  private accept(snapshot: IvySnapshot) {
    if (this.disposed) return;
    const revision = BigInt(snapshot.revision);
    if (revision <= this.highestRevision) return;
    this.highestRevision = revision;
    this.current.set(snapshot);
  }
  private failed(error: unknown) {
    if (!this.disposed)
      this.current.update((state) =>
        error instanceof IvyAdapterError &&
        error.kind === 'native' &&
        error.code
          ? { ...state, error: error.code }
          : { ...state, connection: 'unavailable', error: 'protocol' },
      );
  }
}
