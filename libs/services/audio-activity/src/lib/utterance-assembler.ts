import type { PcmChunk } from './pcm-model';

export function createUtteranceAssembler(): {
  push(
    chunk: PcmChunk,
    gate: { active: boolean; calibrating: boolean },
  ): Int16Array | null;
  reset(): void;
} {
  const MAX_SAMPLES = 320000;
  const PREROLL_SAMPLES = 3840;
  const SILENT_TAIL_SAMPLES = 22400;
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
    if (voiceSamples < MIN_VOICE_SAMPLES) {
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
    gate: { active: boolean; calibrating: boolean },
  ): Int16Array | null {
    if (
      chunk.sampleRate !== 16000 ||
      !Number.isSafeInteger(chunk.sequence) ||
      chunk.sequence < 0 ||
      !(chunk.samples instanceof Int16Array) ||
      chunk.samples.length === 0 ||
      chunk.samples.length > MAX_CHUNK_SAMPLES ||
      typeof gate.active !== 'boolean' ||
      typeof gate.calibrating !== 'boolean'
    ) {
      reset();
      return null;
    }

    if (lastSequence !== null && chunk.sequence !== lastSequence + 1) {
      clearUtterance();
      clearRing();
      waitingForSilence = false;
    }
    lastSequence = chunk.sequence;

    if (gate.calibrating) {
      clearUtterance();
      clearRing();
      waitingForSilence = false;
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
      appendRing(chunk.samples);
      return null;
    }

    const count = Math.min(chunk.samples.length, MAX_SAMPLES - utteranceLength);
    utterance.set(chunk.samples.subarray(0, count), utteranceLength);
    utteranceLength += count;
    if (gate.active) {
      voiceSamples += count;
      silentSamples = 0;
    } else {
      silentSamples += count;
    }

    if (utteranceLength === MAX_SAMPLES) return finish(true);
    if (silentSamples >= SILENT_TAIL_SAMPLES) return finish(false);
    return null;
  }

  return { push, reset };
}
