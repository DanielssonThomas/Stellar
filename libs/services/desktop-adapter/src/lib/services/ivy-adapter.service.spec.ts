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
});
