import { TestBed } from '@angular/core/testing';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ivyConnectCommand,
  type IvySnapshot,
} from '@stellar/desktop-contracts';
import { initialIvySnapshot, type IvyTransport } from '../ivy/ivy-transport';
import { IvyAdapterService, IVY_TRANSPORT } from './ivy-adapter.service';
describe('Ivy service startup and revision ownership', () => {
  afterEach(() => TestBed.resetTestingModule());
  it('subscribes before one silent connection and keeps a newer event over an older reply', async () => {
    let callback!: (value: unknown) => void;
    const events: string[] = [];
    const transport: IvyTransport = {
      listen: async (_event, handler) => {
        events.push('listen');
        callback = handler;
        return vi.fn(() => undefined);
      },
      invoke: vi.fn(async (command) => {
        events.push(command);
        callback({
          ...initialIvySnapshot(),
          revision: '3',
          connection: 'ready',
        } satisfies IvySnapshot);
        return {
          ...initialIvySnapshot(),
          revision: '2',
          connection: 'connecting',
        } satisfies IvySnapshot;
      }),
    };
    TestBed.configureTestingModule({
      providers: [{ provide: IVY_TRANSPORT, useValue: transport }],
    });
    const service = TestBed.inject(IvyAdapterService);
    const first = service.connect(),
      second = service.connect();
    expect(first).toBe(second);
    await first;
    expect(events).toEqual(['listen', ivyConnectCommand]);
    expect(service.state().revision).toBe('3');
    expect(service.state().connection).toBe('ready');
    callback({ ...initialIvySnapshot(), revision: '1' });
    expect(service.state().revision).toBe('3');
  });
  it('keeps a native busy failure separate from a broken transport', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({
        ...initialIvySnapshot(),
        revision: '1',
        connection: 'ready',
      })
      .mockRejectedValueOnce('busy');
    TestBed.configureTestingModule({
      providers: [
        {
          provide: IVY_TRANSPORT,
          useValue: { invoke, listen: async () => vi.fn(() => undefined) },
        },
      ],
    });
    const service = TestBed.inject(IvyAdapterService);
    await service.connect();
    await expect(
      service.submit('hello', '00000000-0000-4000-8000-000000000001'),
    ).rejects.toMatchObject({ code: 'busy' });
    expect(service.state().connection).toBe('ready');
    expect(service.state().error).toBe('busy');
  });
  it('clears a local failure on an equal-revision authoritative snapshot but rejects older data', async () => {
    const ready = {
      ...initialIvySnapshot(),
      revision: '3',
      connection: 'ready',
    } satisfies IvySnapshot;
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(ready)
      .mockRejectedValueOnce('transport failed')
      .mockResolvedValueOnce({
        ...ready,
        revision: '2',
        connection: 'disconnected',
      })
      .mockResolvedValueOnce(ready);
    TestBed.configureTestingModule({
      providers: [
        {
          provide: IVY_TRANSPORT,
          useValue: { invoke, listen: async () => vi.fn() },
        },
      ],
    });
    const service = TestBed.inject(IvyAdapterService);
    await service.connect();
    await expect(service.snapshot()).rejects.toBeDefined();
    expect(service.state()).toMatchObject({
      connection: 'unavailable',
      error: 'protocol',
    });
    await service.snapshot();
    expect(service.state()).toMatchObject({
      revision: '3',
      connection: 'unavailable',
      error: 'protocol',
    });
    await service.snapshot();
    expect(service.state()).toMatchObject({
      revision: '3',
      connection: 'ready',
      error: null,
    });
  });

  it('does not clear a local failure from a delayed equal-revision event', async () => {
    const ready = {
      ...initialIvySnapshot(),
      revision: '5',
      connection: 'ready',
    } satisfies IvySnapshot;
    let event!: (value: unknown) => void;
    const listen = async (_name: string, handler: (value: unknown) => void) => {
      event = handler;
      return vi.fn();
    };
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(ready)
      .mockRejectedValueOnce('broken')
      .mockResolvedValueOnce(ready);
    TestBed.configureTestingModule({
      providers: [{ provide: IVY_TRANSPORT, useValue: { invoke, listen } }],
    });
    const service = TestBed.inject(IvyAdapterService);
    await service.connect();
    await expect(service.snapshot()).rejects.toBeDefined();
    event(ready);
    expect(service.state()).toMatchObject({
      connection: 'unavailable',
      error: 'protocol',
    });
    await service.snapshot();
    expect(service.state()).toMatchObject({ connection: 'ready', error: null });
  });

  it('does not let an older failed request obscure a newer successful snapshot', async () => {
    const ready = {
      ...initialIvySnapshot(),
      revision: '2',
      connection: 'ready',
    } satisfies IvySnapshot;
    let rejectOld!: (reason: unknown) => void;
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(ready)
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectOld = reject;
          }),
      )
      .mockResolvedValueOnce(ready);
    TestBed.configureTestingModule({
      providers: [
        {
          provide: IVY_TRANSPORT,
          useValue: { invoke, listen: async () => vi.fn() },
        },
      ],
    });
    const service = TestBed.inject(IvyAdapterService);
    await service.connect();
    const old = service.snapshot();
    await service.snapshot();
    rejectOld('transport failed');
    await expect(old).rejects.toBeDefined();
    expect(service.state()).toMatchObject({
      revision: '2',
      connection: 'ready',
      error: null,
    });
  });

  it('reports a failed subscription and recovers it on a same-revision reconnect', async () => {
    const ready = {
      ...initialIvySnapshot(),
      revision: '4',
      connection: 'ready',
    } satisfies IvySnapshot;
    const listen = vi
      .fn()
      .mockRejectedValueOnce(new Error('not available'))
      .mockResolvedValueOnce(vi.fn());
    const invoke = vi.fn().mockResolvedValue(ready);
    TestBed.configureTestingModule({
      providers: [{ provide: IVY_TRANSPORT, useValue: { invoke, listen } }],
    });
    const service = TestBed.inject(IvyAdapterService);
    await service.snapshot();
    await expect(service.connect()).rejects.toBeDefined();
    expect(service.state()).toMatchObject({
      connection: 'unavailable',
      error: 'protocol',
    });
    await service.connect();
    expect(service.state()).toMatchObject({
      revision: '4',
      connection: 'ready',
      error: null,
    });
    expect(listen).toHaveBeenCalledTimes(2);
  });

  it('reports durable selection and refuses a busy clear without changing the selection', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({
        ...initialIvySnapshot(),
        revision: '1',
        model: 'sol',
      })
      .mockRejectedValueOnce('busy');
    TestBed.configureTestingModule({
      providers: [
        {
          provide: IVY_TRANSPORT,
          useValue: { invoke, listen: async () => vi.fn() },
        },
      ],
    });
    const service = TestBed.inject(IvyAdapterService);
    expect(await service.selectSession('sol')).toBe(true);
    expect(service.state().verified_model).toBeNull();
    expect(await service.clearConversation()).toBe(false);
    expect(service.state().model).toBe('sol');
  });

  it('exposes busy reconciliation and then an authoritative settled snapshot', async () => {
    const invoke = vi
      .fn()
      .mockRejectedValueOnce('busy')
      .mockResolvedValueOnce({
        ...initialIvySnapshot(),
        revision: '2',
        model: 'sol',
      });
    TestBed.configureTestingModule({
      providers: [
        {
          provide: IVY_TRANSPORT,
          useValue: { invoke, listen: async () => vi.fn() },
        },
      ],
    });
    const service = TestBed.inject(IvyAdapterService);
    await expect(service.snapshot()).rejects.toMatchObject({ code: 'busy' });
    expect((await service.snapshot()).model).toBe('sol');
  });
});
