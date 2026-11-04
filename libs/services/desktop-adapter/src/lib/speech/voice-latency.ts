import type { SpeechSnapshot } from '@stellar/desktop-contracts';

type Stage =
  | 'speech_end_observed'
  | 'vad_finalized'
  | 'stt_request'
  | 'stt_completed'
  | 'inference_start'
  | 'inference_complete'
  | 'action_dispatch'
  | 'action_complete'
  | 'hermes_submit'
  | 'first_model_delta'
  | 'hermes_admitted'
  | 'first_validated_text'
  | 'model_completed'
  | 'tts_request'
  | 'tts_synthesis_observed'
  | 'first_audio_observed'
  | 'playback_observed'
  | 'playback_completed';

/** Local, bounded performance entries: no utterance/session IDs or conversation content. */
export class VoiceLatency {
  private active = false;
  private speechEnd?: number;
  private start?: number;
  private stages: Partial<Record<Stage, number>> = {};
  private native: SpeechSnapshot['timings'];
  private static readonly entry = 'stellar.voice.latency';

  constructor(private readonly clock = () => performance.now()) {}

  activity(active: boolean) {
    if (active) this.speechEnd = undefined;
    else if (this.active) this.speechEnd = this.clock();
    this.active = active;
  }

  begin() {
    const now = this.clock();
    this.start = this.speechEnd ?? now;
    this.stages = {
      ...(this.speechEnd === undefined ? {} : { speech_end_observed: 0 }),
      vad_finalized: now - this.start,
    };
    this.speechEnd = undefined;
    this.native = undefined;
  }

  point(stage: Stage) {
    if (this.start !== undefined && this.stages[stage] === undefined)
      this.stages[stage] = this.clock() - this.start;
  }

  speech(snapshot: SpeechSnapshot) {
    if (snapshot.state === 'synthesizing') this.point('tts_synthesis_observed');
    if (snapshot.timings)
      this.native = snapshot.timings.map((item) => ({ ...item }));
    if (snapshot.timings?.some((timing) => timing.stage === 'first_audio'))
      this.point('first_audio_observed');
    if (snapshot.state === 'speaking') this.point('playback_observed');
    if (snapshot.state === 'idle' && this.stages.tts_request !== undefined) {
      this.point('playback_completed');
      this.finish('completed');
    }
  }

  finish(outcome: 'completed' | 'interrupted') {
    if (this.start === undefined) return;
    const difference = (end: Stage, start: Stage) =>
      this.stages[end] !== undefined && this.stages[start] !== undefined
        ? this.stages[end] - this.stages[start]
        : null;
    const workerSpan = (end: string, start: string) => {
      const last = this.native?.find((item) => item.stage === end)?.elapsed_ms;
      const first = this.native?.find(
        (item) => item.stage === start,
      )?.elapsed_ms;
      return last === undefined || first === undefined ? null : last - first;
    };
    const entries = performance.getEntriesByName(VoiceLatency.entry);
    if (entries.length >= 64) performance.clearMeasures(VoiceLatency.entry);
    performance.measure(VoiceLatency.entry, {
      start: this.start,
      end: this.clock(),
      detail: {
        outcome,
        stages_ms: { ...this.stages },
        worker_timings_ms: this.native ?? [],
        durations_ms: {
          utterance_settlement: difference(
            'vad_finalized',
            'speech_end_observed',
          ),
          stt: difference('stt_completed', 'stt_request'),
          local_inference: difference('inference_complete', 'inference_start'),
          local_action: difference('action_complete', 'action_dispatch'),
          transcript_to_action: difference('action_complete', 'stt_completed'),
          speech_end_to_action: difference(
            'action_complete',
            'speech_end_observed',
          ),
          prompt_preparation: difference('hermes_submit', 'stt_completed'),
          admission: difference('hermes_admitted', 'hermes_submit'),
          validated_model_text: difference(
            'first_validated_text',
            'hermes_submit',
          ),
          first_model_delta: difference('first_model_delta', 'hermes_submit'),
          tts_startup_observed: difference(
            'tts_synthesis_observed',
            'tts_request',
          ),
          worker_synthesis_span_including_backpressure: workerSpan(
            'synthesis_completed',
            'synthesis_started',
          ),
          worker_synthesis_to_first_audio: workerSpan(
            'first_audio',
            'synthesis_started',
          ),
          worker_playback_span: workerSpan(
            'playback_completed',
            'playback_dispatched',
          ),
          tts_to_first_audio_observed: difference(
            'first_audio_observed',
            'tts_request',
          ),
          end_to_end_first_audio_observed: difference(
            'first_audio_observed',
            'vad_finalized',
          ),
          end_to_end_playback_observed: difference(
            'playback_observed',
            'vad_finalized',
          ),
          speech_end_to_first_audio_observed: difference(
            'first_audio_observed',
            'speech_end_observed',
          ),
        },
        first_audible_ms: null,
      },
    });
    this.start = undefined;
  }
}
