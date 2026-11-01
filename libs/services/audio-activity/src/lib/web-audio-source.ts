import type { AudioSink, AudioSource, AudioStatus } from './audio-model';

export interface WebAudioSourceDependencies {
  readonly acquire?: (deviceId?: string) => Promise<MediaStream>;
  readonly audio?: () => AudioContext;
  readonly now?: () => number;
  readonly schedule?: (callback: () => void) => () => void;
}

interface Session {
  readonly generation: number;
  sink: AudioSink | undefined;
  context: AudioContext | undefined;
  stream: MediaStream | undefined;
  source: MediaStreamAudioSourceNode | undefined;
  analyser: AnalyserNode | undefined;
  cancel: (() => void) | undefined;
  readonly removers: (() => void)[];
  status: AudioStatus | undefined;
}

function defaultAcquire(deviceId?: string): Promise<MediaStream> {
  if (
    typeof navigator === 'undefined' ||
    !navigator.mediaDevices?.getUserMedia
  ) {
    throw new Error('Media capture is unavailable');
  }
  return navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      ...(deviceId === undefined ? {} : { deviceId: { exact: deviceId } }),
    },
    video: false,
  });
}

function failureStatus(error: unknown): AudioStatus {
  const name =
    typeof error === 'object' && error !== null && 'name' in error
      ? error.name
      : undefined;
  if (name === 'NotAllowedError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError')
    return 'missing';
  return 'unavailable';
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      /* Continue releasing the remaining tracks. */
    }
  }
}

export class WebAudioSource implements AudioSource {
  private generation = 0;
  private current: Session | undefined;
  private readonly acquire: (deviceId?: string) => Promise<MediaStream>;
  private readonly audio: () => AudioContext;
  private readonly now: () => number;
  private readonly schedule: (callback: () => void) => () => void;

  constructor(dependencies: WebAudioSourceDependencies = {}) {
    this.acquire = dependencies.acquire ?? defaultAcquire;
    this.audio = dependencies.audio ?? (() => new AudioContext());
    this.now = dependencies.now ?? (() => performance.now());
    this.schedule =
      dependencies.schedule ??
      ((callback) => {
        const timer = globalThis.setInterval(callback, 33);
        return () => globalThis.clearInterval(timer);
      });
  }

  private isCurrent(session: Session): boolean {
    return this.current === session && this.generation === session.generation;
  }

  private emit(session: Session, status: AudioStatus): void {
    if (!this.isCurrent(session) || session.status === status) return;
    session.status = status;
    session.sink?.status(status);
  }

  private release(session: Session): Promise<void> {
    const cancel = session.cancel;
    session.cancel = undefined;
    try {
      cancel?.();
    } catch {
      /* Cleanup must still release capture. */
    }
    for (const remove of session.removers.splice(0)) remove();
    try {
      session.source?.disconnect();
    } catch {
      /* Graph may already be closed. */
    }
    try {
      session.analyser?.disconnect();
    } catch {
      /* Graph may already be closed. */
    }
    session.source = undefined;
    session.analyser = undefined;
    if (session.stream) stopTracks(session.stream);
    session.stream = undefined;
    const context = session.context;
    session.context = undefined;
    session.sink = undefined;
    if (!context) return Promise.resolve();
    try {
      return Promise.resolve(context.close()).catch(() => undefined);
    } catch {
      return Promise.resolve();
    }
  }

  private async finish(session: Session, status: AudioStatus): Promise<void> {
    if (!this.isCurrent(session)) return;
    try {
      this.emit(session, status);
    } finally {
      // A trusted callback may synchronously start a replacement session.
      if (this.isCurrent(session)) {
        this.current = undefined;
        ++this.generation;
      }
      await this.release(session);
    }
  }

  stop(): Promise<void> {
    const session = this.current;
    if (!session) return Promise.resolve();
    return this.finish(session, 'idle');
  }

  async start(sink: AudioSink, deviceId?: string): Promise<void> {
    // Teardown is synchronous except closing the old context; never await it here.
    const previousGeneration = this.generation;
    void this.stop().catch(() => undefined);
    if (this.current || this.generation > previousGeneration + 1) return;
    const session: Session = {
      generation: ++this.generation,
      sink,
      context: undefined,
      stream: undefined,
      source: undefined,
      analyser: undefined,
      cancel: undefined,
      removers: [],
      status: undefined,
    };
    this.current = session;
    let stream: MediaStream;
    try {
      const context = this.audio();
      session.context = context;
      // Invoke resume in the initiating gesture, without waiting for permission.
      const resumed = context.resume();
      void Promise.resolve(resumed).catch(() => {
        void this.finish(session, 'unavailable').catch(() => undefined);
      });
      this.emit(session, 'requesting');
      if (!this.isCurrent(session)) return;
      stream = await this.acquire(deviceId);
    } catch (error: unknown) {
      await this.finish(session, failureStatus(error));
      return;
    }
    if (!this.isCurrent(session)) {
      stopTracks(stream);
      return;
    }
    session.stream = stream;
    try {
      const context = session.context;
      if (!context) throw new Error('Audio context is unavailable');
      const tracks = stream.getAudioTracks();
      if (tracks.length === 0) {
        await this.finish(session, 'missing');
        return;
      }
      for (const track of tracks) {
        const ended = (): void => {
          void this.finish(session, 'disconnected').catch(() => undefined);
        };
        const muted = (): void => {
          void this.finish(session, 'muted').catch(() => undefined);
        };
        track.addEventListener('ended', ended);
        track.addEventListener('mute', muted);
        session.removers.push(() => {
          track.removeEventListener('ended', ended);
          track.removeEventListener('mute', muted);
        });
      }
      if (tracks.some((track) => track.readyState === 'ended')) {
        await this.finish(session, 'disconnected');
        return;
      }
      if (tracks.some((track) => track.muted)) {
        await this.finish(session, 'muted');
        return;
      }
      const source = context.createMediaStreamSource(stream);
      session.source = source;
      const analyser = context.createAnalyser();
      session.analyser = analyser;
      analyser.fftSize = 1024;
      source.connect(analyser);
      const samples = new Float32Array(1024);
      const stateChanged = (): void => {
        if (!this.isCurrent(session)) return;
        if (context.state === 'closed') {
          void this.finish(session, 'unavailable').catch(() => undefined);
        } else {
          this.emit(
            session,
            context.state === 'running' ? 'capturing' : 'suspended',
          );
        }
      };
      context.addEventListener('statechange', stateChanged);
      session.removers.push(() =>
        context.removeEventListener('statechange', stateChanged),
      );
      const sample = (): void => {
        if (!this.isCurrent(session) || context.state !== 'running') return;
        let rms: number;
        let peak = 0;
        let clipped = false;
        let timestampMs: number;
        try {
          analyser.getFloatTimeDomainData(samples);
          let sum = 0;
          for (const value of samples) {
            if (!Number.isFinite(value)) return;
            const magnitude = Math.abs(value);
            const bounded = Math.min(1, magnitude);
            sum += bounded * bounded;
            peak = Math.max(peak, bounded);
            clipped ||= magnitude >= 0.999;
          }
          rms = Math.min(1, Math.max(0, Math.sqrt(sum / samples.length)));
          timestampMs = this.now();
          if (!Number.isFinite(timestampMs) || !Number.isFinite(rms)) return;
        } catch {
          void this.finish(session, 'unavailable').catch(() => undefined);
          return;
        }
        if (this.isCurrent(session) && context.state === 'running') {
          session.sink?.frame({ timestampMs, rms, peak, clipped });
        }
      };
      const cancel = this.schedule(sample);
      if (!this.isCurrent(session)) {
        cancel();
        return;
      }
      session.cancel = cancel;
      stateChanged();
    } catch (error: unknown) {
      await this.finish(session, failureStatus(error));
    }
  }
}
