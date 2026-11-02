export interface CaptureIdentity {
  readonly requestId: number | null;
  readonly deviceId: string;
  readonly available: boolean;
  readonly status: string;
}

export class VoiceCaptureGate {
  private paused = false;
  private generation = 0;
  private pending: Promise<void> = Promise.resolve();
  private identity?: CaptureIdentity;
  private failedRequestId: number | null = null;
  private disposed = false;

  constructor(
    private readonly current: () => CaptureIdentity,
    private readonly release: () => Promise<void>,
    private readonly acquire: (deviceId?: string) => Promise<void>,
    private readonly onFailure: () => void,
  ) {}

  setPaused(paused: boolean): void {
    if (this.disposed || paused === this.paused) return;
    this.paused = paused;
    const generation = ++this.generation;
    if (paused) {
      this.pauseCurrent();
      return;
    }
    const identity = this.identity;
    this.identity = undefined;
    if (!identity) return;
    void this.pending
      .then(() => {
        const now = this.current();
        if (
          this.disposed ||
          this.paused ||
          generation !== this.generation ||
          !now.available ||
          now.requestId !== identity.requestId ||
          now.requestId === this.failedRequestId ||
          now.deviceId !== identity.deviceId ||
          now.status !== 'turn-paused'
        )
          return;
        return this.acquire(identity.deviceId || undefined);
      })
      .catch(() => {
        const now = this.current();
        if (
          !this.disposed &&
          !this.paused &&
          generation === this.generation &&
          now.available &&
          now.requestId === identity.requestId &&
          now.deviceId === identity.deviceId &&
          ['turn-paused', 'requesting'].includes(now.status)
        )
          this.onFailure();
      });
  }

  async waitForRelease(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = this.pending;
    const identity = this.identity;
    const generation = this.generation;
    try {
      if (
        identity?.requestId === this.failedRequestId &&
        identity?.requestId !== null
      )
        throw new Error('Capture release previously timed out');
      await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('Capture release timed out')),
            5000,
          );
        }),
      ]);
      const now = this.current();
      if (
        this.disposed ||
        !this.paused ||
        this.generation !== generation ||
        this.pending !== pending ||
        this.identity !== identity ||
        !now.available ||
        (identity
          ? now.requestId !== identity.requestId ||
            now.deviceId !== identity.deviceId ||
            now.status !== 'turn-paused'
          : now.requestId !== null ||
            ['capturing', 'requesting'].includes(now.status))
      )
        throw new Error('Capture release no longer applies');
    } catch (error) {
      const now = this.current();
      if (
        !this.disposed &&
        this.paused &&
        this.identity === identity &&
        this.pending === pending &&
        this.generation === generation &&
        identity &&
        now.available &&
        now.requestId === identity.requestId &&
        now.deviceId === identity.deviceId
      ) {
        this.failedRequestId = identity.requestId;
        this.onFailure();
      }
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  refresh(): void {
    if (this.disposed || !this.paused) return;
    if (['capturing', 'requesting'].includes(this.current().status)) {
      ++this.generation;
      this.pauseCurrent();
    }
  }

  private pauseCurrent(): void {
    const identity = this.current();
    if (identity.requestId === null || !identity.available) return;
    if (identity.status === 'turn-paused') {
      this.identity = identity;
      return;
    }
    if (!['capturing', 'requesting'].includes(identity.status)) return;
    if (
      this.failedRequestId !== null &&
      this.failedRequestId !== identity.requestId
    ) {
      this.pending = Promise.resolve();
      this.failedRequestId = null;
    }
    this.identity = identity;
    this.pending = Promise.all([this.pending, this.release()]).then(
      () => undefined,
    );
    void this.pending.catch(() => undefined);
  }

  dispose(): void {
    this.disposed = true;
    ++this.generation;
    this.identity = undefined;
  }
}
