import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserPane, type MediaNativeApi } from './browser-pane';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
function setup() {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const element = document.createElement('div');
  document.body.append(element);
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
    x: 20,
    y: 80,
    width: 500,
    height: 400,
  } as DOMRect);
  let callback: (event: { payload: unknown }) => void = () => undefined;
  const stop = vi.fn();
  const invoke = vi.fn<MediaNativeApi['core']['invoke']>(async () => null);
  const api: MediaNativeApi = {
    core: { invoke },
    event: {
      listen: vi.fn(async (_, cb) => {
        callback = cb;
        return stop;
      }),
    },
  };
  const change = vi.fn();
  const pane = createBrowserPane(api, element, 'https://example.com/', change);
  const emit = (
    state: string,
    url = 'https://example.com/',
    generation = 1,
  ) => {
    const open = invoke.mock.calls.find(
      (call) =>
        (call[1].request as { operation: { action: string } }).operation
          .action === 'open',
    );
    const id = (open?.[1].request as { operation: { id: string } }).operation
      .id;
    callback({ payload: { id, state, url, generation } });
  };
  return { pane, element, api, invoke, stop, change, emit, frames };
}
describe('native browser pane owner', () => {
  it('reconciles a new URL requested while native creation is still in flight', async () => {
    const { pane, invoke } = setup();
    let release: () => void = () => undefined;
    invoke.mockImplementationOnce(
      () =>
        new Promise((done) => {
          release = () => done(null);
        }),
    );
    await flush();
    pane.navigate('https://example.com/new');
    release();
    await flush();
    const operations = invoke.mock.calls.map(
      ([, args]) =>
        (
          args.request as {
            operation: { action: string; url?: string; generation?: number };
          }
        ).operation,
    );
    expect(operations[0].action).toBe('open');
    expect(operations[1]).toMatchObject({
      action: 'navigate',
      url: 'https://example.com/new',
      generation: 2,
    });
    pane.dispose();
  });
  it('reports native website focus without changing the current loading state or URL', async () => {
    const { pane, emit, change } = setup();
    await flush();
    emit('focused', '', 1);
    expect(change).toHaveBeenLastCalledWith({
      url: 'https://example.com/',
      pending: true,
      error: null,
      focused: true,
    });
    pane.dispose();
  });
  it('retries a failed resource-limited open only after an explicit reload', async () => {
    const { pane, invoke, change } = setup();
    invoke.mockRejectedValueOnce('limit');
    await flush();
    expect(change).toHaveBeenLastCalledWith(
      expect.objectContaining({
        error: expect.stringContaining('could not be opened'),
      }),
    );
    pane.control('reload');
    await flush();
    expect(
      invoke.mock.calls.filter(
        ([, args]) =>
          (args.request as { operation: { action: string } }).operation
            .action === 'open',
      ),
    ).toHaveLength(2);
    pane.dispose();
  });
  it('recovers visibility when the current page finishes after the loading timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { pane, emit, change, frames, invoke } = setup();
    await flush();
    emit('loading');
    vi.advanceTimersByTime(20_000);
    expect(change).toHaveBeenLastCalledWith(
      expect.objectContaining({
        error: expect.stringContaining('did not finish'),
      }),
    );
    emit('ready');
    expect(change).toHaveBeenLastCalledWith(
      expect.objectContaining({ pending: false, error: null }),
    );
    frames.shift()?.(performance.now());
    await flush();
    const operations = invoke.mock.calls.map(
      ([, args]) =>
        (
          args.request as {
            operation: { action: string; bounds?: { visible: boolean } };
          }
        ).operation,
    );
    expect(operations.at(-1)?.bounds?.visible).toBe(true);
    pane.dispose();
  });
  it('creates once, routes native navigation events and preserves its ID across control operations', async () => {
    const { pane, invoke, emit, change, stop } = setup();
    await flush();
    expect(invoke.mock.calls[0][0]).toBe('workspace_browser');
    emit('loading');
    emit('ready');
    expect(change).toHaveBeenLastCalledWith({
      url: 'https://example.com/',
      pending: false,
      error: null,
    });
    pane.navigate('https://example.com/docs');
    await flush();
    pane.control('back');
    await flush();
    pane.control('reload');
    await flush();
    const operations = invoke.mock.calls.map(
      (call) =>
        (call[1].request as { operation: { action: string; id: string } })
          .operation,
    );
    expect(operations.map((op) => op.action)).toEqual([
      'open',
      'navigate',
      'back',
      'reload',
    ]);
    expect(new Set(operations.map((op) => op.id)).size).toBe(1);
    pane.dispose();
    await flush();
    expect(stop).toHaveBeenCalledOnce();
    expect(
      (
        invoke.mock.calls.at(-1)?.[1].request as {
          operation: { action: string };
        }
      ).operation.action,
    ).toBe('close');
    const count = change.mock.calls.length;
    emit('ready');
    expect(change).toHaveBeenCalledTimes(count);
  });
  it('fences a late event registration and never creates an orphan after disposal', async () => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    let resolve!: (stop: () => void) => void;
    const stop = vi.fn(),
      invoke = vi.fn<MediaNativeApi['core']['invoke']>(async () => null);
    const api: MediaNativeApi = {
      core: { invoke },
      event: {
        listen: () =>
          new Promise((done) => {
            resolve = done;
          }),
      },
    };
    const pane = createBrowserPane(
      api,
      document.createElement('div'),
      'https://example.com/',
      vi.fn(),
    );
    pane.dispose();
    resolve(stop);
    await flush();
    expect(stop).toHaveBeenCalledOnce();
    expect(
      invoke.mock.calls.map(
        (call) =>
          (call[1].request as { operation: { action: string } }).operation
            .action,
      ),
    ).toEqual(['close']);
  });
  it('renders a controlled blocked-navigation state and ignores malformed remote event content', async () => {
    const { pane, emit, change } = setup();
    await flush();
    emit('execute');
    expect(change).not.toHaveBeenLastCalledWith(
      expect.objectContaining({ error: 'execute' }),
    );
    emit('loading');
    emit('blocked');
    expect(change).toHaveBeenLastCalledWith(
      expect.objectContaining({
        pending: false,
        error: expect.stringContaining('Navigation blocked'),
      }),
    );
    pane.dispose();
  });
  it('ignores old navigation completions, including a reload of the same URL', async () => {
    const { pane, emit, change } = setup();
    await flush();
    pane.navigate('https://example.com/new');
    emit('ready', 'https://example.com/', 1);
    expect(change).toHaveBeenLastCalledWith(
      expect.objectContaining({
        url: 'https://example.com/new',
        pending: true,
      }),
    );
    await flush();
    emit('loading', 'https://example.com/new', 2);
    emit('ready', 'https://example.com/new', 2);
    expect(change).toHaveBeenLastCalledWith(
      expect.objectContaining({
        url: 'https://example.com/new',
        pending: false,
      }),
    );
    pane.control('reload');
    emit('ready', 'https://example.com/new', 2);
    expect(change).toHaveBeenLastCalledWith(
      expect.objectContaining({ pending: true }),
    );
    emit('loading', 'https://example.com/new', 3);
    emit('ready', 'https://example.com/new', 3);
    expect(change).toHaveBeenLastCalledWith(
      expect.objectContaining({ pending: false }),
    );
    pane.dispose();
  });
  it('tracks position-only transitions with a bounded frame stream and a final bounds update', async () => {
    const { pane, element, invoke, frames } = setup();
    await flush();
    const frame = () => {
      const next = frames.shift();
      if (!next) throw Error('Missing animation frame');
      next(performance.now());
    };
    frame();
    await flush();
    const bounds = vi.spyOn(element, 'getBoundingClientRect');
    bounds.mockReturnValue({
      x: 150,
      y: 80,
      width: 500,
      height: 400,
    } as DOMRect);
    element.dispatchEvent(
      new CustomEvent('stellar-stage-layout', {
        bubbles: true,
        detail: { duration: 420 },
      }),
    );
    frame();
    await flush();
    bounds.mockReturnValue({
      x: 600,
      y: 80,
      width: 500,
      height: 400,
    } as DOMRect);
    frame();
    await flush();
    const positions = invoke.mock.calls.flatMap(([, args]) => {
      const op = (
        args.request as {
          operation: { action: string; bounds?: { x: number } };
        }
      ).operation;
      return op.action === 'bounds' ? [op.bounds?.x] : [];
    });
    expect(positions).toContain(150);
    expect(positions.at(-1)).toBe(600);
    pane.dispose();
  });
});
