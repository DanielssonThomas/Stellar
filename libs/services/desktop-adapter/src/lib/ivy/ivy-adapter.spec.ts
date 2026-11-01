import { describe, it, expect, vi } from 'vitest';
import {
  ivyConnectCommand,
  ivySubmitCommand,
} from '@stellar/desktop-contracts';
import { IvyAdapter } from './ivy-adapter';
import { initialIvySnapshot, type IvyTransport } from './ivy-transport';
function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((r) => (resolve = r)), resolve };
}
describe('Ivy adapter ownership', () => {
  it('releases a listener registered after disposal', async () => {
    const registration = deferred<() => void>();
    const stop = vi.fn(() => undefined);
    const adapter = new IvyAdapter({
      invoke: vi.fn(async () => initialIvySnapshot()),
      listen: () => registration.promise,
    });
    const pending = adapter.subscribe(
      vi.fn(() => undefined),
      vi.fn(() => undefined),
    );
    adapter.dispose();
    registration.resolve(stop);
    await pending;
    expect(stop).toHaveBeenCalledOnce();
  });
  it('rejects an in-flight result after disposal', async () => {
    const reply = deferred<unknown>();
    const adapter = new IvyAdapter({
      invoke: () => reply.promise,
      listen: async () => () => undefined,
    });
    const pending = adapter.request(ivyConnectCommand, { version: 1 });
    adapter.dispose();
    reply.resolve(initialIvySnapshot());
    await expect(pending).rejects.toMatchObject({ kind: 'disposed' });
  });
  it('validates requests before transport and sanitizes unexpected failures', async () => {
    const invoke = vi
      .fn(async () => initialIvySnapshot())
      .mockRejectedValue(new Error('private ticket'));
    const adapter = new IvyAdapter({
      invoke,
      listen: async () => () => undefined,
    });
    await expect(
      adapter.request(ivySubmitCommand, {
        version: 1,
        input_id: 'invalid',
        text: 'hello',
      }),
    ).rejects.toMatchObject({ kind: 'contract' });
    expect(invoke).not.toHaveBeenCalled();
    await expect(
      adapter.request(ivyConnectCommand, { version: 1 }),
    ).rejects.toThrow('Ivy adapter: transport');
  });
  it('ignores late callbacks after unsubscription and rejects malformed snapshots', async () => {
    let callback!: (payload: unknown) => void;
    const transport: IvyTransport = {
      invoke: vi.fn(async () => initialIvySnapshot()),
      listen: async (_event, handler) => {
        callback = handler;
        return vi.fn(() => undefined);
      },
    };
    const adapter = new IvyAdapter(transport);
    const changed = vi.fn(() => undefined),
      error = vi.fn(() => undefined);
    const stop = await adapter.subscribe(changed, error);
    callback({ ...initialIvySnapshot(), connection: 'unknown' });
    expect(error).toHaveBeenCalledOnce();
    expect(changed).not.toHaveBeenCalled();
    stop();
    callback(initialIvySnapshot());
    expect(changed).not.toHaveBeenCalled();
  });
});
