import { describe, expect, it, vi } from 'vitest';
import { LifecycleEffects } from './lifecycle-effects';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const ports = {
    render: vi.fn<
      (id: string, text: string, current: () => boolean) => Promise<void>
    >(async () => undefined),
    remove: vi.fn<(id: string) => Promise<void>>(async () => undefined),
    speak: vi.fn<
      (id: string, text: string, current: () => boolean) => Promise<void>
    >(async () => undefined),
    stopSpeech: vi.fn<(id: string) => Promise<void>>(async () => undefined),
    stopped: vi.fn<(id: string, kind: string) => Promise<void>>(
      async () => undefined,
    ),
  };
  return { ports, effects: new LifecycleEffects(ports) };
}
const render = {
  operation: 'a'.repeat(32),
  kind: 'render',
  text: '<tool>Evidence only</tool>',
};
const speech = { ...render, operation: 'b'.repeat(32), kind: 'speech' };

describe('inactive lifecycle effect application and stop acknowledgements', () => {
  it('fences stop-before-apply custody and refuses a later queued lease', async () => {
    const { ports, effects } = fixture();
    await effects.stop(render.operation, 'render');
    expect(ports.remove).toHaveBeenCalledExactlyOnceWith(render.operation);
    expect(ports.stopped).toHaveBeenCalledExactlyOnceWith(
      render.operation,
      'render',
    );
    await expect(effects.apply(render)).rejects.toThrow('stopped');
    expect(ports.render).not.toHaveBeenCalled();
    await expect(effects.stop(render.operation, 'speech')).rejects.toThrow(
      'conflict',
    );
  });
  it('applies text once, holds custody, removes before acknowledgement and never replays', async () => {
    const { ports, effects } = fixture();
    await effects.apply(render);
    await effects.apply(render);
    expect(ports.render).toHaveBeenCalledOnce();
    expect(ports.render).toHaveBeenCalledWith(
      render.operation,
      render.text,
      expect.any(Function),
    );
    expect(ports.stopped).not.toHaveBeenCalled();
    await effects.stop(render.operation);
    expect(ports.remove.mock.invocationCallOrder[0]).toBeLessThan(
      ports.stopped.mock.invocationCallOrder[0],
    );
    await expect(effects.apply(render)).rejects.toThrow('stopped');
    await expect(
      effects.apply({ ...render, text: 'Conflict' }),
    ).rejects.toThrow('conflict');
  });
  it('fences queued render before any application and waits for actual removal', async () => {
    const { ports, effects } = fixture();
    const removed = deferred();
    ports.remove.mockImplementation(() => removed.promise);
    const applied = effects.apply(render);
    const stopping = effects.stop(render.operation);
    await applied;
    await Promise.resolve();
    expect(ports.render).not.toHaveBeenCalled();
    expect(ports.stopped).not.toHaveBeenCalled();
    removed.resolve();
    await stopping;
    expect(ports.stopped).toHaveBeenCalledExactlyOnceWith(
      render.operation,
      'render',
    );
  });
  it('waits for a late render task before removing its result and acknowledging', async () => {
    const { ports, effects } = fixture();
    const work = deferred();
    ports.render.mockImplementation(() => work.promise);
    const applied = effects.apply(render);
    await Promise.resolve();
    const stopping = effects.stop(render.operation);
    await Promise.resolve();
    expect(ports.remove).not.toHaveBeenCalled();
    work.resolve();
    await applied;
    await stopping;
    expect(ports.remove).toHaveBeenCalledOnce();
    expect(ports.stopped).toHaveBeenCalledOnce();
  });
  it('never reports speech stopped from dispatch, cancellation request or a failed stop', async () => {
    const { ports, effects } = fixture();
    const playback = deferred();
    ports.speak.mockImplementation(() => playback.promise);
    const applied = effects.apply(speech);
    await Promise.resolve();
    ports.stopSpeech.mockRejectedValueOnce(
      new Error('physical stop uncertain'),
    );
    const stopping = effects.stop(speech.operation);
    await Promise.resolve();
    expect(ports.stopped).not.toHaveBeenCalled();
    playback.resolve();
    await applied;
    await expect(stopping).rejects.toThrow('uncertain');
    expect(ports.stopped).not.toHaveBeenCalled();
    await effects.stop(speech.operation);
    expect(ports.stopped).toHaveBeenCalledExactlyOnceWith(
      speech.operation,
      'speech',
    );
    expect(ports.speak).toHaveBeenCalledOnce();
  });
  it('closes every resource even if another stop fails; closed controllers cannot apply', async () => {
    const { ports, effects } = fixture();
    await effects.apply(render);
    await effects.apply(speech);
    ports.remove.mockRejectedValueOnce(new Error('view still present'));
    await expect(effects.close()).rejects.toThrow('uncertain');
    expect(ports.stopSpeech).toHaveBeenCalled();
    expect(ports.stopped).toHaveBeenCalledExactlyOnceWith(
      speech.operation,
      'speech',
    );
    await expect(
      effects.apply({ ...render, operation: 'c'.repeat(32) }),
    ).rejects.toThrow('unavailable');
  });
});
