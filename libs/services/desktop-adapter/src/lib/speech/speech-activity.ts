import {
  ActivityDetector,
  type ActivitySnapshot,
} from '@stellar/service-audio-activity';

/** Speech uses the capture calibration without changing the visual activity meter. */
export class SpeechActivity {
  private readonly detector = new ActivityDetector({
    calibrationMs: 0,
    minimumOn: 0.003,
    minimumOff: 0.0018,
    minActiveMs: 80,
  });
  private elapsed = 0;
  private quiet = 0;
  private voice = false;

  quietMs() {
    return this.quiet;
  }
  voiced() {
    return this.voice;
  }

  reset() {
    this.elapsed = 0;
    this.quiet = 0;
    this.voice = false;
    this.detector.reset();
  }

  push(samples: Int16Array, calibration: ActivitySnapshot): ActivitySnapshot {
    if (calibration.calibrating) {
      this.reset();
      return calibration;
    }
    if (this.elapsed === 0)
      this.detector.push({
        timestampMs: 0,
        rms: calibration.noiseFloor,
        peak: 0,
        clipped: false,
      });
    this.elapsed += samples.length / 16;
    let energy = 0;
    for (const sample of samples) energy += (sample / 32768) ** 2;
    const rms = Math.sqrt(energy / samples.length);
    this.voice = rms >= Math.max(0.0018, calibration.noiseFloor * 1.8);
    this.quiet = this.voice ? 0 : this.quiet + samples.length / 16;
    return this.detector.push({
      timestampMs: this.elapsed,
      rms,
      peak: 0,
      clipped: false,
    });
  }
}
