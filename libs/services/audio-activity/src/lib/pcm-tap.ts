import { validPcmChunk, type PcmEvent } from './pcm-model';

export interface PcmTapDependencies {
  readonly url?: string;
  readonly createNode?: (context: AudioContext) => AudioWorkletNode;
}

export async function attachPcmTap(
  context: AudioContext,
  source: MediaStreamAudioSourceNode,
  emit: (event: PcmEvent) => void,
  current: () => boolean,
  dependencies: PcmTapDependencies = {},
): Promise<() => void> {
  if (!context.audioWorklet) throw new Error('PCM capture is unavailable');
  await context.audioWorklet.addModule(
    dependencies.url ??
      new URL('audio-worklets/stellar-pcm-worklet.js', document.baseURI).href,
  );
  if (!current()) return () => undefined;
  const node = dependencies.createNode
    ? dependencies.createNode(context)
    : new AudioWorkletNode(context, 'stellar-pcm', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
  let active = true;
  const stop = () => {
    if (!active) return;
    active = false;
    node.port.onmessage = null;
    node.onprocessorerror = null;
    for (const release of [
      () => node.port.postMessage({ stop: true }),
      () => node.port.close(),
      () => node.disconnect(),
      () => source.disconnect(node),
    ]) {
      try {
        release();
      } catch {
        // Continue disconnecting other graph resources after a partial failure.
      }
    }
  };
  node.port.onmessage = ({ data }: MessageEvent<unknown>) => {
    if (!active || !current()) {
      if (validPcmChunk(data)) data.samples.fill(0);
      return;
    }
    if (!validPcmChunk(data)) {
      emit({ type: 'reset' });
      return;
    }
    try {
      emit({ type: 'chunk', chunk: data });
    } finally {
      if (active) node.port.postMessage({ ack: data.sequence });
    }
  };
  node.onprocessorerror = () => {
    if (active && current()) emit({ type: 'unavailable' });
    stop();
  };
  try {
    source.connect(node);
    // A silent output keeps the graph pulled without monitoring microphone audio.
    node.connect(context.destination);
    return stop;
  } catch (error) {
    stop();
    throw error;
  }
}
