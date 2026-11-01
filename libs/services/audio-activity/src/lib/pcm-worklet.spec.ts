import { afterEach, describe, expect, it, vi } from 'vitest';

interface Processor {
  readonly port: {
    onmessage: (event: { data: unknown }) => void;
    close: ReturnType<typeof vi.fn>;
    postMessage: ReturnType<typeof vi.fn>;
  };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

describe('actual PCM worklet queue ownership', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('bounds outstanding messages, exposes dropped chunks as sequence gaps and produces silent output', async () => {
    const processors: (new () => Processor)[] = [];
    class WorkletBase {
      readonly port = {
        onmessage: () => undefined,
        close: vi.fn(),
        postMessage: vi.fn(),
      };
    }
    vi.stubGlobal('AudioWorkletProcessor', WorkletBase);
    vi.stubGlobal('sampleRate', 16000);
    vi.stubGlobal(
      'registerProcessor',
      (_name: string, processor: new () => Processor) =>
        processors.push(processor),
    );
    await import('../../worklet/stellar-pcm-worklet.js');
    const processor = new processors[0]();
    const output = new Float32Array(640).fill(1);
    const block = new Float32Array(640).fill(0.5);
    for (let index = 0; index < 20; index++)
      processor.process([[block]], [[output]]);
    expect([...output]).toEqual(Array(640).fill(0));
    expect(processor.port.postMessage).toHaveBeenCalledTimes(4);
    expect(
      processor.port.postMessage.mock.calls.map(
        ([message]) => message.sequence,
      ),
    ).toEqual([0, 1, 2, 3]);
    processor.port.onmessage({ data: { ack: 0 } });
    processor.process([[block]], [[output]]);
    expect(processor.port.postMessage.mock.lastCall?.[0].sequence).toBe(20);
    processor.port.onmessage({ data: { stop: true } });
    expect(processor.port.close).toHaveBeenCalledOnce();
    expect(processor.process([[block]], [[output]])).toBe(false);
    expect(processor.port.postMessage).toHaveBeenCalledTimes(5);
  });
});
