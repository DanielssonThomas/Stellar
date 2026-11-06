export type MicrophoneStatus =
  | 'idle'
  | 'requesting'
  | 'running'
  | 'suspended'
  | 'denied'
  | 'no-device'
  | 'unavailable'
  | 'device-ended';

export type MicrophoneSnapshot = {
  status: MicrophoneStatus;
  rms: number;
  peak: number;
  dbfs: number | null;
  frames: number;
  context: AudioContextState | 'absent';
  contextTime: number | null;
  sampleRate: number | null;
  track: MediaStreamTrackState | 'absent';
  muted: boolean | null;
  input: string;
};

type Dependencies = {
  acquire: (deviceId?: string) => Promise<MediaStream>;
  audio: () => AudioContext;
};

export class MicrophoneProbe {
  private generation = 0;
  private stream: MediaStream | undefined;
  private context: AudioContext | undefined;
  private source: MediaStreamAudioSourceNode | undefined;
  private analyser: AnalyserNode | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private status: MicrophoneStatus = 'idle';
  private frames = 0;

  constructor(
    private readonly update: (snapshot: MicrophoneSnapshot) => void,
    private readonly dependencies: Dependencies = {
      acquire: (deviceId) =>
        navigator.mediaDevices.getUserMedia({
          audio: {
            ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
          video: false,
        }),
      audio: () => new AudioContext(),
    },
  ) {}

  async start(deviceId?: string): Promise<void> {
    if (['requesting', 'running', 'suspended'].includes(this.status)) return;
    const generation = ++this.generation;
    this.frames = 0;
    this.publish('requesting');
    try {
      const context = this.dependencies.audio();
      this.context = context;
      context.addEventListener('statechange', () => {
        if (generation === this.generation) this.publish(this.status);
      });
      void context.resume().catch(() => {
        if (generation === this.generation) void this.stop('unavailable');
      });
      this.publish('requesting');
      const stream = await this.dependencies.acquire(deviceId);
      if (generation !== this.generation) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.stream = stream;
      const tracks = stream.getAudioTracks();
      if (tracks.length === 0) {
        await this.stop('no-device');
        return;
      }
      const analyser = context.createAnalyser();
      this.analyser = analyser;
      analyser.fftSize = 1024;
      this.source = context.createMediaStreamSource(stream);
      this.source.connect(analyser);
      for (const track of tracks) {
        track.addEventListener(
          'ended',
          () => {
            if (generation === this.generation) void this.stop('device-ended');
          },
          { once: true },
        );
        for (const event of ['mute', 'unmute'])
          track.addEventListener(event, () => {
            if (generation === this.generation) this.publish(this.status);
          });
      }
      const samples = new Float32Array(analyser.fftSize);
      this.timer = setInterval(() => {
        analyser.getFloatTimeDomainData(samples);
        this.frames += 1;
        const rms = Math.sqrt(
          samples.reduce((sum, sample) => sum + sample * sample, 0) /
            samples.length,
        );
        const peak = samples.reduce(
          (maximum, sample) => Math.max(maximum, Math.abs(sample)),
          0,
        );
        this.publish('running', rms, peak);
      }, 67);
      this.publish('running');
    } catch (error) {
      if (generation !== this.generation) return;
      const name = error instanceof Error ? error.name : '';
      await this.stop(
        name === 'NotAllowedError'
          ? 'denied'
          : name === 'NotFoundError' || name === 'OverconstrainedError'
            ? 'no-device'
            : 'unavailable',
      );
    }
  }

  async resume(): Promise<void> {
    if (!this.context) return;
    const generation = this.generation;
    try {
      await this.context.resume();
      if (generation === this.generation) this.publish(this.status);
    } catch {
      if (generation === this.generation) await this.stop('unavailable');
    }
  }

  async stop(status: MicrophoneStatus = 'idle'): Promise<void> {
    this.generation += 1;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.source?.disconnect();
    this.analyser?.disconnect();
    this.source = undefined;
    this.analyser = undefined;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
    const context = this.context;
    this.context = undefined;
    this.publish(status);
    if (context && context.state !== 'closed') await context.close();
  }

  private publish(status: MicrophoneStatus, rms = 0, peak = 0): void {
    this.status = ['running', 'suspended'].includes(status)
      ? this.context?.state === 'running'
        ? 'running'
        : 'suspended'
      : status;
    const track = this.stream?.getAudioTracks()[0];
    this.update({
      status: this.status,
      rms,
      peak,
      dbfs: rms > 0 ? 20 * Math.log10(rms) : null,
      frames: this.frames,
      context: this.context?.state ?? 'absent',
      contextTime: this.context?.currentTime ?? null,
      sampleRate: this.context?.sampleRate ?? null,
      track: track?.readyState ?? 'absent',
      muted: track?.muted ?? null,
      input: track?.label || 'Default input (label unavailable)',
    });
  }
}
