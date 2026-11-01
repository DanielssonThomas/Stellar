import { describe, expect, it, vi } from 'vitest';
import { attachPcmTap } from './pcm-tap';

function fixture() {
  const port = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    postMessage: vi.fn(),
    close: vi.fn(),
  };
  const node = {
    port,
    onprocessorerror: null as (() => void) | null,
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  const source = { connect: vi.fn(), disconnect: vi.fn() };
  const context = {
    audioWorklet: { addModule: vi.fn(async () => undefined) },
    destination: {},
  };
  const emit = vi.fn();
  let current = true;
  const createNode = vi.fn(() => node as unknown as AudioWorkletNode);
  const attach = () =>
    attachPcmTap(
      context as unknown as AudioContext,
      source as unknown as MediaStreamAudioSourceNode,
      emit,
      () => current,
      { url: '/audio-worklets/stellar-pcm-worklet.js', createNode },
    );
  return {
    port,
    node,
    source,
    context,
    emit,
    createNode,
    attach,
    stale: () => {
      current = false;
    },
  };
}

describe('same-stream PCM tap', () => {
  it('uses the existing graph, validates chunks, and ignores callbacks after release', async () => {
    const f = fixture();
    const stop = await f.attach();
    expect(f.source.connect).toHaveBeenCalledWith(f.node);
    const callback = f.port.onmessage;
    const chunk = {
      sampleRate: 16000,
      sequence: 0,
      samples: new Int16Array(640),
    };
    callback?.(new MessageEvent('message', { data: chunk }));
    expect(f.emit).toHaveBeenLastCalledWith({ type: 'chunk', chunk });
    callback?.(
      new MessageEvent('message', { data: { ...chunk, sampleRate: 48000 } }),
    );
    expect(f.emit).toHaveBeenLastCalledWith({ type: 'reset' });
    stop();
    stop();
    expect(f.node.disconnect).toHaveBeenCalledOnce();
    expect(f.source.disconnect).toHaveBeenCalledExactlyOnceWith(f.node);
    f.emit.mockClear();
    callback?.(new MessageEvent('message', { data: chunk }));
    expect(f.emit).not.toHaveBeenCalled();
  });

  it('does not attach after delayed module loading outlives capture', async () => {
    const f = fixture();
    const pending = f.attach();
    f.stale();
    const stop = await pending;
    stop();
    expect(f.createNode).not.toHaveBeenCalled();
  });

  it('releases every resource on processor failure even if one cleanup throws', async () => {
    const f = fixture();
    await f.attach();
    f.port.postMessage.mockImplementation(() => {
      throw Error('closed port');
    });
    f.node.onprocessorerror?.();
    expect(f.emit).toHaveBeenLastCalledWith({ type: 'unavailable' });
    expect(f.port.close).toHaveBeenCalledOnce();
    expect(f.source.disconnect).toHaveBeenCalledOnce();
  });
});
