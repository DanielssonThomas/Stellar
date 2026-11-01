import '@angular/compiler';
import {
  Component,
  DestroyRef,
  inject,
  NgZone,
  provideZonelessChangeDetection,
} from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { AudioActivityService, SyntheticAudioSource } from '../../src/index';
@Component({
  selector: 'stellar-audio-fixture',
  standalone: true,
  providers: [AudioActivityService],
  template: ` <h1>Audio activity fixture</h1>
    <p>Manual mode uses synthetic levels; microphone remains opt-in.</p>
    <button (click)="microphone()">Microphone</button
    ><button (click)="demo()">Manual demo</button>
    <button (click)="level = 0.1">Sound on</button
    ><button (click)="level = 0">Sound off</button>
    <button (click)="stop()">Stop</button><button (click)="mute()">Mute</button
    ><button (click)="hide()">Minimize</button>
    <p id="status">{{ audio.state().status }}</p>
    <p id="calibration">
      {{
        audio.state().activity.calibrating
          ? 'Calibrating: stay quiet'
          : 'Calibrated'
      }}
    </p>
    <p id="activity">
      {{ audio.state().activity.active ? 'Audio activity' : 'Quiet' }}
    </p>
    <meter min="0" max="1" [value]="audio.state().activity.level"></meter>
    <p id="summary">
      {{ audio.state().activity.durationMs }} ms; peak
      {{ audio.state().activity.peakLevel }}
    </p>`,
})
class AudioActivityFixtureComponent {
  readonly audio = inject(AudioActivityService);
  readonly zone = inject(NgZone);
  level = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor() {
    inject(DestroyRef).onDestroy(() => this.clear());
  }
  clear() {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }
  async demo() {
    this.clear();
    this.level = 0;
    const source = new SyntheticAudioSource();
    await this.audio.start(source);
    this.zone.runOutsideAngular(() => {
      this.timer = setInterval(
        () =>
          source.push({
            timestampMs: performance.now(),
            rms: this.level,
            peak: this.level,
            clipped: false,
          }),
        33,
      );
    });
  }
  microphone() {
    this.clear();
    void this.audio.startMicrophone();
  }
  stop() {
    this.clear();
    void this.audio.stop();
  }
  mute() {
    this.clear();
    void this.audio.mute();
  }
  hide() {
    this.clear();
    void this.audio.suspend();
  }
}
void bootstrapApplication(AudioActivityFixtureComponent, {
  providers: [provideZonelessChangeDetection()],
});
