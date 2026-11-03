import type { PcmChunk } from './pcm-model';

export function createUtteranceAssembler(
  options: { silenceMs?: number; draftSilenceMs?: number } = {},
): {
  push(
    chunk: PcmChunk,
    gate: {
      active: boolean;
      calibrating: boolean;
      starting?: boolean;
      draft?: boolean;
    },
  ): Int16Array | null;
  snapshot(): Int16Array | null;
  lastResultCapped(): boolean;
  hasCappedContinuation(): boolean;
  reset(): void;
} {
  const MAX_SAMPLES = 320000;
  const PREROLL_SAMPLES = 3840;
  function silence(value: number | undefined, fallback: number): number {
    if (value === undefined) return fallback;
    if (!Number.isFinite(value) || value < 240 || value > 3000)
      throw new RangeError('Invalid speech endpoint');
    return Math.round(value * 16);
  }
  const SILENT_TAIL_SAMPLES = silence(options.silenceMs, 22400);
  const DRAFT_SILENT_TAIL_SAMPLES = silence(options.draftSilenceMs, 8640);
  const MIN_VOICE_SAMPLES = 3200;
  const MAX_CHUNK_SAMPLES = 640;

  const preroll = new Int16Array(PREROLL_SAMPLES);
  const utterance = new Int16Array(MAX_SAMPLES);
  let ringStart = 0;
  let ringLength = 0;
  let utteranceLength = 0;
  let voiceSamples = 0;
  let silentSamples = 0;
  let lastSequence: number | null = null;
  let waitingForSilence = false;
  let resultCapped = false;
  let cappedContinuation = false;

  function erase(array: Int16Array, length: number): void {
    array.fill(0, 0, length);
  }

  function clearUtterance(): void {
    erase(utterance, utteranceLength);
    utteranceLength = 0;
    voiceSamples = 0;
    silentSamples = 0;
  }

  function clearRing(): void {
    erase(preroll, PREROLL_SAMPLES);
    ringStart = 0;
    ringLength = 0;
  }

  function reset(): void {
    clearUtterance();
    clearRing();
    lastSequence = null;
    waitingForSilence = false;
    resultCapped = false;
    cappedContinuation = false;
  }

  function appendRing(samples: Int16Array): void {
    for (let i = 0; i < samples.length; i++) {
      if (ringLength < PREROLL_SAMPLES) {
        preroll[(ringStart + ringLength) % PREROLL_SAMPLES] = samples[i];
        ringLength++;
      } else {
        preroll[ringStart] = samples[i];
        ringStart = (ringStart + 1) % PREROLL_SAMPLES;
      }
    }
  }

  function finish(capped: boolean): Int16Array | null {
    if (voiceSamples < MIN_VOICE_SAMPLES && !cappedContinuation) {
      clearUtterance();
      return null;
    }
    const output = utterance.slice(0, utteranceLength);
    clearUtterance();
    clearRing();
    waitingForSilence = capped;
    return output;
  }

  function push(
    chunk: PcmChunk,
    gate: {
      active: boolean;
      calibrating: boolean;
      starting?: boolean;
      draft?: boolean;
    },
  ): Int16Array | null {
    resultCapped = false;
    if (
      chunk.sampleRate !== 16000 ||
      !Number.isSafeInteger(chunk.sequence) ||
      chunk.sequence < 0 ||
      !(chunk.samples instanceof Int16Array) ||
      chunk.samples.length === 0 ||
      chunk.samples.length > MAX_CHUNK_SAMPLES ||
      typeof gate.active !== 'boolean' ||
      typeof gate.calibrating !== 'boolean' ||
      (gate.starting !== undefined && typeof gate.starting !== 'boolean') ||
      (gate.draft !== undefined && typeof gate.draft !== 'boolean')
    ) {
      reset();
      return null;
    }

    if (lastSequence !== null && chunk.sequence !== lastSequence + 1) {
      clearUtterance();
      clearRing();
      waitingForSilence = false;
      cappedContinuation = false;
    }
    lastSequence = chunk.sequence;

    if (gate.calibrating) {
      clearUtterance();
      clearRing();
      waitingForSilence = false;
      cappedContinuation = false;
      return null;
    }

    if (waitingForSilence) {
      if (gate.active) {
        silentSamples = 0;
        return null;
      }
      waitingForSilence = false;
      silentSamples = 0;
      appendRing(chunk.samples);
      return null;
    }

    if (utteranceLength === 0 && gate.active) {
      for (let i = 0; i < ringLength; i++) {
        utterance[utteranceLength++] =
          preroll[(ringStart + i) % PREROLL_SAMPLES];
      }
      clearRing();
    }

    if (utteranceLength === 0 && !gate.active) {
      if (cappedContinuation) {
        silentSamples = gate.starting
          ? 0
          : silentSamples + chunk.samples.length;
        if (silentSamples >= DRAFT_SILENT_TAIL_SAMPLES) {
          cappedContinuation = false;
          silentSamples = 0;
        }
      }
      appendRing(chunk.samples);
      return null;
    }

    const count = Math.min(chunk.samples.length, MAX_SAMPLES - utteranceLength);
    utterance.set(chunk.samples.subarray(0, count), utteranceLength);
    utteranceLength += count;
    if (gate.active) {
      voiceSamples += count;
      silentSamples = 0;
    } else if (gate.starting) {
      silentSamples = 0;
    } else {
      silentSamples += count;
    }

    if (utteranceLength === MAX_SAMPLES) {
      resultCapped = true;
      const output = finish(!gate.draft);
      cappedContinuation = Boolean(gate.draft && output);
      if (cappedContinuation && count < chunk.samples.length) {
        const remainder = chunk.samples.subarray(count);
        utterance.set(remainder);
        utteranceLength = remainder.length;
        if (gate.active) voiceSamples = remainder.length;
        else silentSamples = remainder.length;
      }
      return output;
    }
    if (
      silentSamples >=
      (gate.draft ? DRAFT_SILENT_TAIL_SAMPLES : SILENT_TAIL_SAMPLES)
    ) {
      const output = finish(false);
      cappedContinuation = false;
      return output;
    }
    return null;
  }

  function snapshot(): Int16Array | null {
    return !waitingForSilence && voiceSamples >= MIN_VOICE_SAMPLES
      ? utterance.slice(0, utteranceLength)
      : null;
  }

  return {
    push,
    snapshot,
    lastResultCapped: () => resultCapped,
    hasCappedContinuation: () => cappedContinuation,
    reset,
  };
}
