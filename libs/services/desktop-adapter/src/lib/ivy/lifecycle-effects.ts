import {
  decodeIvyLifecycleLease,
  type IvyLifecycleKind,
  type IvyLifecycleLease,
} from '@stellar/desktop-contracts';

interface Ports {
  /** Text-only surface; resolves after the view has actually applied the change. */
  render(
    operation: string,
    text: string,
    current: () => boolean,
  ): Promise<void>;
  /** Resolves after this operation is absent from the actual view. */
  remove(operation: string): Promise<void>;
  /** Resolves on physical completion, not synthesis/dispatch acknowledgement. */
  speak(operation: string, text: string, current: () => boolean): Promise<void>;
  /** Fences queued synthesis and acknowledges actual playback stop. */
  stopSpeech(operation: string): Promise<void>;
  /** Local acknowledgement to the original native custodian, never direct host RPC. */
  stopped(operation: string, kind: IvyLifecycleKind): Promise<void>;
}

interface Resource {
  lease: IvyLifecycleLease;
  cancelled: boolean;
  pending: Promise<void>;
  stopping?: Promise<void>;
  acknowledged: boolean;
  unapplied?: boolean;
}

/** Inactive controller: no production IPC/consent adapter is registered yet.
 * Native must persist and claim custody before passing a lease. Lifecycle text
 * never reaches presentation/tool parsing or the ordinary background speech cue.
 */
export class LifecycleEffects {
  private readonly resources = new Map<string, Resource>();
  private closed = false;

  constructor(private readonly ports: Ports) {}

  apply(value: unknown): Promise<void> {
    const lease = decodeIvyLifecycleLease(value);
    const previous = this.resources.get(lease.operation);
    if (previous) {
      if (
        previous.lease.kind !== lease.kind ||
        (!previous.unapplied && previous.lease.text !== lease.text)
      )
        return Promise.reject(new Error('Lifecycle operation conflict'));
      return previous.cancelled
        ? Promise.reject(new Error('Lifecycle operation stopped'))
        : previous.pending;
    }
    if (this.closed || this.resources.size >= 32)
      return Promise.reject(new Error('Lifecycle effects unavailable'));
    const resource: Resource = {
      lease,
      cancelled: false,
      pending: Promise.resolve(),
      acknowledged: false,
    };
    this.resources.set(lease.operation, resource);
    const current = () => !this.closed && !resource.cancelled;
    // Defer application until resource ownership is installed; stop can win
    // before this microtask without leaving a queued effect behind.
    resource.pending = Promise.resolve().then(async () => {
      if (!current()) return;
      if (lease.kind === 'render') {
        await this.ports.render(lease.operation, lease.text, current);
      } else {
        const text =
          new TextEncoder().encode(lease.text).length <= 4000
            ? lease.text
            : 'I have an update for you. It is available in the conversation.';
        await this.ports.speak(lease.operation, text, current);
      }
    });
    return resource.pending;
  }

  stop(operation: string, kind?: IvyLifecycleKind): Promise<void> {
    let resource = this.resources.get(operation);
    if (!resource) {
      if (kind === undefined || this.resources.size >= 32)
        return Promise.reject(new Error('Unknown lifecycle operation'));
      // Native can own custody before an apply message arrives. Retain an absent
      // operation's stop fence so any later queued application is refused.
      const lease = decodeIvyLifecycleLease({
        operation,
        kind,
        text: 'Absent operation',
      });
      resource = {
        lease,
        cancelled: true,
        pending: Promise.resolve(),
        acknowledged: false,
        unapplied: true,
      };
      this.resources.set(operation, resource);
    } else if (kind !== undefined && resource.lease.kind !== kind) {
      return Promise.reject(new Error('Lifecycle operation conflict'));
    }
    if (resource.acknowledged) return Promise.resolve();
    if (resource.stopping) return resource.stopping;
    resource.cancelled = true;
    const pending = this.stopResource(resource);
    resource.stopping = pending;
    void pending.catch(() => {
      // Failed local stop or lost local ACK never reports stopped. A later
      // explicit stop may re-check physical state, never reapply the effect.
      if (resource.stopping === pending) resource.stopping = undefined;
    });
    return pending;
  }

  private async stopResource(resource: Resource): Promise<void> {
    const { operation, kind } = resource.lease;
    let initialStop: unknown;
    if (kind === 'speech') {
      try {
        await this.ports.stopSpeech(operation);
      } catch (error) {
        initialStop = error;
      }
    }
    // Even a failed/uncertain application must finish its local queue before
    // the final removal/stop acknowledgement can be issued.
    await resource.pending.catch(() => undefined);
    if (kind === 'render') await this.ports.remove(operation);
    else await this.ports.stopSpeech(operation);
    if (initialStop) throw initialStop;
    await this.ports.stopped(operation, kind);
    resource.acknowledged = true;
  }

  async close(): Promise<void> {
    this.closed = true;
    const results = await Promise.allSettled(
      [...this.resources.keys()].map((operation) => this.stop(operation)),
    );
    if (results.some((result) => result.status === 'rejected'))
      throw new Error('Lifecycle stop remains uncertain');
  }
}
