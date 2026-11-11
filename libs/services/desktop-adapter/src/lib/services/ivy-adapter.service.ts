import {
  DestroyRef,
  Injectable,
  InjectionToken,
  inject,
  signal,
} from '@angular/core';
import {
  ivyConnectCommand,
  ivySnapshotCommand,
  ivySubmitCommand,
  ivyCancelCommand,
  ivyReconcileCommand,
  ivyDisconnectCommand,
  ivySelectSessionCommand,
  ivyClearConversationCommand,
  ivyNewSessionCommand,
  ivyReloadMcpCommand,
  ivyQuestionReplyCommand,
  type IvyQuestionAction,
  type IvyModel,
  type IvyCommands,
  type IvySnapshot,
  type IvyLocalActionEvent,
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
  private authoritative = initialIvySnapshot();
  private operationSequence = 0;
  private latestOutcome = 0;
  private localFailure?: Partial<Pick<IvySnapshot, 'connection' | 'error'>>;
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
  submit(text: string, inputId: string, localActions?: IvyLocalActionEvent[]) {
    return this.invoke(ivySubmitCommand, {
      version: 1,
      text,
      input_id: inputId,
      ...(localActions?.length ? { local_actions: localActions } : {}),
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
  snapshot() {
    return this.invoke(ivySnapshotCommand, { version: 1 });
  }

  questionReply(promptId: string, action: IvyQuestionAction) {
    return this.invoke(ivyQuestionReplyCommand, {
      version: 1,
      prompt_id: promptId,
      action,
    });
  }

  async selectSession(model: IvyModel): Promise<boolean> {
    try {
      const state = await this.invoke(ivySelectSessionCommand, {
        version: 1,
        model,
      });
      return state.model === model;
    } catch {
      return false;
    }
  }
  async clearConversation(): Promise<boolean> {
    try {
      const state = await this.invoke(ivyClearConversationCommand, {
        version: 1,
      });
      return (
        state.model === 'terra' &&
        state.turn === 'idle' &&
        state.turn_id === null
      );
    } catch {
      return false;
    }
  }

  async newSession(): Promise<boolean> {
    const state = await this.invoke(ivyNewSessionCommand, { version: 1 });
    return (
      state.turn === 'idle' &&
      state.turn_id === null &&
      state.activity.length === 0 &&
      !state.error
    );
  }
  async reloadMcp(): Promise<boolean> {
    try {
      await this.invoke(ivyReloadMcpCommand, { version: 1 });
      return true;
    } catch (error) {
      if (error instanceof IvyAdapterError && error.code === 'busy')
        return false;
      throw error;
    }
  }

  private listen(): Promise<() => void> {
    if (!this.subscription) {
      const operation = ++this.operationSequence;
      const pending = this.adapter.subscribe(
        (snapshot) => this.accept(snapshot, ++this.operationSequence, false),
        (error) => this.failed(error, ++this.operationSequence),
      );
      this.subscription = pending;
      void pending.catch((error) => {
        if (this.subscription === pending) this.subscription = undefined;
        this.failed(error, operation);
      });
    }
    return this.subscription;
  }
  private async invoke<K extends keyof IvyCommands>(
    command: K,
    request: IvyCommands[K],
  ): Promise<IvySnapshot> {
    const operation = ++this.operationSequence;
    try {
      const snapshot = await this.adapter.request(command, request);
      this.accept(snapshot, operation, true);
      return this.current();
    } catch (error) {
      if (!this.disposed) this.failed(error, operation);
      throw error;
    }
  }
  private accept(
    snapshot: IvySnapshot,
    operation: number,
    allowEqual: boolean,
  ) {
    if (this.disposed) return;
    const revision = BigInt(snapshot.revision);
    if (
      revision < this.highestRevision ||
      (revision === this.highestRevision && !allowEqual)
    )
      return;
    if (revision > this.highestRevision) {
      this.highestRevision = revision;
      this.authoritative = snapshot;
    }
    if (operation >= this.latestOutcome) {
      this.latestOutcome = operation;
      this.localFailure = undefined;
    }
    this.current.set({ ...this.authoritative, ...this.localFailure });
  }
  private failed(error: unknown, operation: number) {
    if (this.disposed || operation < this.latestOutcome) return;
    this.latestOutcome = operation;
    this.localFailure =
      error instanceof IvyAdapterError && error.kind === 'native' && error.code
        ? { error: error.code }
        : { connection: 'unavailable', error: 'protocol' };
    this.current.set({ ...this.authoritative, ...this.localFailure });
  }
}
