import { afterEach, describe, expect, it } from 'vitest';
import { VoiceLatency } from './voice-latency';
import { initialSpeechSnapshot } from './speech-transport';

describe('content-free voice latency observations', () => {
  afterEach(() => performance.clearMeasures('stellar.voice.latency'));

  it('keeps acknowledgment timing separate from validated answer and final audio', () => {
    let now = 0;
    const latency = new VoiceLatency(() => now);
    latency.begin();
    latency.point('hermes_submit');
    now = 50;
    latency.point('hermes_admitted');
    now = 750;
    latency.point('acknowledgment_requested');
    now = 1050;
    latency.point('acknowledgment_playback_observed');
    now = 3000;
    latency.point('first_validated_text');
    latency.point('model_completed');
    latency.point('tts_request');
    now = 3300;
    latency.speech({
      ...initialSpeechSnapshot(),
      state: 'speaking',
      timings: [{ stage: 'first_audio', elapsed_ms: 300 }],
    });
    now = 4000;
    latency.speech({ ...initialSpeechSnapshot(), state: 'idle' });
    const entry = performance.getEntriesByName(
      'stellar.voice.latency',
    )[0] as PerformanceMeasure;
    expect(entry.detail.stages_ms.acknowledgment_playback_observed).toBe(1050);
    expect(entry.detail.durations_ms.validated_model_text).toBe(3000);
    expect(entry.detail.durations_ms.end_to_end_first_audio_observed).toBe(
      3300,
    );
    expect(entry.detail.first_audible_ms).toBeNull();
  });

  it('includes observed speech-end to utterance-finalization settlement without changing VAD', () => {
    let now = 0;
    const latency = new VoiceLatency(() => now);
    latency.activity(true);
    now = 500;
    latency.activity(false);
    now = 1900;
    latency.begin();
    now = 2000;
    latency.finish('interrupted');
    const entry = performance.getEntriesByName(
      'stellar.voice.latency',
    )[0] as PerformanceMeasure;
    expect(entry.detail.durations_ms.utterance_settlement).toBe(1400);
    expect(entry.detail.stages_ms.vad_finalized).toBe(1400);
  });

  it('calculates local durations and leaves unavailable provider/acoustic timings null', () => {
    let now = 0;
    const latency = new VoiceLatency(() => now);
    latency.begin();
    now = 20;
    latency.point('stt_request');
    now = 220;
    latency.point('stt_completed');
    now = 230;
    latency.point('hermes_submit');
    now = 240;
    latency.point('hermes_admitted');
    now = 900;
    latency.point('model_completed');
    latency.point('first_validated_text');
    now = 910;
    latency.point('tts_request');
    now = 1100;
    latency.speech({
      ...initialSpeechSnapshot(),
      state: 'speaking',
      timings: [{ stage: 'first_audio', elapsed_ms: 180 }],
    });
    now = 1300;
    latency.speech({ ...initialSpeechSnapshot(), state: 'idle' });
    const entry = performance.getEntriesByName(
      'stellar.voice.latency',
    )[0] as PerformanceMeasure;
    expect(entry.detail.durations_ms).toMatchObject({
      stt: 200,
      prompt_preparation: 10,
      admission: 10,
      validated_model_text: 670,
      tts_to_first_audio_observed: 190,
      end_to_end_first_audio_observed: 1100,
    });
    expect(entry.detail.durations_ms.first_model_delta).toBeNull();
    expect(entry.detail.first_audible_ms).toBeNull();
    expect(Object.keys(entry.detail)).not.toContain('text');
  });

  it('bounds retained entries and fences old timings after cancellation', () => {
    let now = 0;
    const latency = new VoiceLatency(() => now);
    for (let index = 0; index < 130; index++) {
      latency.begin();
      now++;
      latency.finish('interrupted');
      latency.point('tts_request');
      latency.speech({ ...initialSpeechSnapshot(), state: 'idle' });
    }
    const entries = performance.getEntriesByName(
      'stellar.voice.latency',
    ) as PerformanceMeasure[];
    expect(entries.length).toBeLessThanOrEqual(64);
    expect(
      entries.every((entry) => entry.detail.outcome === 'interrupted'),
    ).toBe(true);
  });
});
