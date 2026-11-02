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
    try {
      await Promise.race([
        this.pending,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('Capture release timed out')),
            5000,
          );
        }),
      ]);
    } catch (error) {
      const now = this.current();
      if (
        !this.disposed &&
        this.paused &&
        this.identity &&
        now.available &&
        now.requestId === this.identity.requestId &&
        now.deviceId === this.identity.deviceId &&
        now.status === 'turn-paused'
      )
        this.onFailure();
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
    this.identity = identity;
    this.pending = Promise.all([this.pending, this.release()])
      .then(() => undefined)
      .catch(() => undefined);
  }

  dispose(): void {
    this.disposed = true;
    ++this.generation;
    this.identity = undefined;
  }
}
