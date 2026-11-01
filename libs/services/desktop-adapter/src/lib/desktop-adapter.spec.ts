import { describe, expect, it, vi } from 'vitest';
import { DesktopAdapter, DesktopAdapterError } from './desktop-adapter';
import {
  createBrowserDesktopTransport,
  createNativeDesktopTransport,
  type DesktopTransport,
} from './desktop-transport';

const request = { version: 1, sequence: '18446744073709551615' };
const reply = {
  ...request,
  application: 'stellar-desktop',
  capabilities: [{ kind: 'native_window' }],
  build_revision: null,
};

function controlled() {
  let callback: (value: unknown) => void = () => undefined;
  const unlisten = vi.fn();
  const transport: DesktopTransport = {
    invoke: vi.fn(async () => reply),
    listen: vi.fn(async (_event, consumer) => {
      callback = consumer;
      return unlisten;
    }),
  };
  return { transport, unlisten, emit: (value: unknown) => callback(value) };
}

describe('typed desktop adapter', () => {
  it('finishes all subscription cleanup if one native cancellation fails', async () => {
    const release = vi.fn().mockImplementationOnce(() => {
      throw new Error('private native path');
    });
    const adapter = new DesktopAdapter({
      invoke: async () => reply,
      listen: async () => release,
    });
    await adapter.subscribe(vi.fn(), vi.fn());
    await adapter.subscribe(vi.fn(), vi.fn());
    expect(() => adapter.dispose()).toThrow(
      new DesktopAdapterError('transport'),
    );
    expect(release).toHaveBeenCalledTimes(2);
    expect(() => adapter.dispose()).not.toThrow();
  });
  it('provides the same bounded API in a browser without native permissions', async () => {
    const adapter = new DesktopAdapter(createBrowserDesktopTransport());
    const callback = vi.fn();
    const unsubscribe = await adapter.subscribe(callback, vi.fn());
    expect(await adapter.appInfo(request)).toEqual({
      ...reply,
      capabilities: [],
    });
    expect(callback).toHaveBeenCalledWith({
      version: 1,
      info: { ...reply, capabilities: [] },
    });
    unsubscribe();
    await adapter.appInfo(request);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('uses only generated command/event names and unwraps native event envelopes', async () => {
    const invoke = vi.fn(async () => reply);
    let emit: (event: { payload: unknown }) => void = () => undefined;
    const unlisten = vi.fn();
    const listen = vi.fn(async (_name, callback) => {
      emit = callback;
      return unlisten;
    });
    const adapter = new DesktopAdapter(
      createNativeDesktopTransport({ core: { invoke }, event: { listen } }),
    );
    const observed = vi.fn();
    await adapter.subscribe(observed, vi.fn());
    expect(await adapter.appInfo(request)).toEqual(reply);
    expect(invoke).toHaveBeenCalledWith('app_info', { request });
    expect(listen.mock.calls[0][0]).toBe('app-info-observed');
    emit({ payload: { version: 1, info: reply } });
    expect(observed).toHaveBeenCalledOnce();
    adapter.dispose();
    adapter.dispose();
    emit({ payload: { version: 1, info: reply } });
    expect(observed).toHaveBeenCalledOnce();
    expect(unlisten).toHaveBeenCalledOnce();
    await expect(adapter.appInfo(request)).rejects.toMatchObject({
      kind: 'disposed',
    });
  });

  it('validates requests before transport and validates reply correlation and versions', async () => {
    const fake = controlled();
    const adapter = new DesktopAdapter(fake.transport);
    await expect(
      adapter.appInfo({ ...request, sequence: '01' }),
    ).rejects.toMatchObject({ kind: 'contract' });
    expect(fake.transport.invoke).not.toHaveBeenCalled();
    vi.mocked(fake.transport.invoke).mockResolvedValueOnce({
      ...reply,
      sequence: '0',
    });
    await expect(adapter.appInfo(request)).rejects.toMatchObject({
      kind: 'contract',
    });
    vi.mocked(fake.transport.invoke).mockResolvedValueOnce({
      ...reply,
      version: 2,
    });
    await expect(adapter.appInfo(request)).rejects.toMatchObject({
      kind: 'contract',
      detail: { kind: 'unsupported-version' },
    });
  });

  it('maps known native failures and hides unknown transport messages', async () => {
    const fake = controlled();
    const adapter = new DesktopAdapter(fake.transport);
    vi.mocked(fake.transport.invoke).mockRejectedValueOnce({
      code: 'event_unavailable',
    });
    await expect(adapter.appInfo(request)).rejects.toMatchObject({
      kind: 'native',
      detail: { code: 'event_unavailable' },
    });
    vi.mocked(fake.transport.invoke).mockRejectedValueOnce(
      new Error('secret file path'),
    );
    await expect(adapter.appInfo(request)).rejects.toEqual(
      new DesktopAdapterError('transport'),
    );
  });

  it('rejects malformed events without notifying subscribers and ignores queued events after unsubscribe', async () => {
    const fake = controlled();
    const adapter = new DesktopAdapter(fake.transport);
    const observed = vi.fn(),
      errors = vi.fn();
    const unsubscribe = await adapter.subscribe(observed, errors);
    fake.emit({
      version: 1,
      info: { ...reply, capabilities: [{ kind: 'unknown' }] },
    });
    expect(errors).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'contract' }),
    );
    expect(observed).not.toHaveBeenCalled();
    unsubscribe();
    unsubscribe();
    fake.emit({ version: 1, info: reply });
    expect(observed).not.toHaveBeenCalled();
    expect(fake.unlisten).toHaveBeenCalledOnce();
  });

  it('releases a subscription that finishes registering after disposal', async () => {
    let resolve: (unlisten: () => void) => void = () => undefined;
    const registered = new Promise<() => void>((done) => {
      resolve = done;
    });
    const unlisten = vi.fn();
    const adapter = new DesktopAdapter({
      invoke: async () => reply,
      listen: () => registered,
    });
    const pending = adapter.subscribe(vi.fn(), vi.fn());
    adapter.dispose();
    resolve(unlisten);
    const stop = await pending;
    stop();
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it('rejects an in-flight response after disposal', async () => {
    let resolve: (value: unknown) => void = () => undefined;
    const pending = new Promise((done) => {
      resolve = done;
    });
    const adapter = new DesktopAdapter({
      invoke: () => pending,
      listen: async () => () => undefined,
    });
    const result = adapter.appInfo(request);
    adapter.dispose();
    resolve(reply);
    await expect(result).rejects.toMatchObject({ kind: 'disposed' });
  });
});
