import type { AudioFrame, AudioSink, AudioSource } from './audio-model';

export class SyntheticAudioSource implements AudioSource {
  private sink: AudioSink | undefined;

  async start(sink: AudioSink): Promise<void> {
    void this.stop();
    this.sink = sink;
    sink.status('capturing');
  }

  push(frame: AudioFrame): void {
    this.sink?.frame({ ...frame });
  }

  async stop(): Promise<void> {
    const sink = this.sink;
    this.sink = undefined;
    sink?.status('idle');
  }
}
