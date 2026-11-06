import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AWARENESS_TRANSPORT,
  DesktopAwarenessService,
  type AwarenessTransport,
} from './desktop-awareness.service';

const frame = (revision = '1', enabled = true) => ({
  version: 1,
  revision,
  enabled,
  app_health: enabled ? 'unavailable' : 'paused',
  media_health: enabled ? 'unavailable' : 'paused',
  media_observed_at_ms: null,
  foreground: null,
  last_external: null,
  spotify: null,
  workspace: null,
});
const flush = async () => {
  for (let n = 0; n < 12; n++) await Promise.resolve();
};
afterEach(() => {
  TestBed.resetTestingModule();
  vi.useRealTimers();
});
describe('desktop awareness adapter', () => {
  it('distinguishes healthy absent Spotify from unavailable and stale observations', async () => {
    vi.useFakeTimers();
    let listener: (payload: unknown) => void = () => undefined;
    TestBed.configureTestingModule({
      providers: [
        {
          provide: AWARENESS_TRANSPORT,
          useValue: {
            invoke: async () => ({
              ...frame(),
              media_health: 'available',
              media_observed_at_ms: String(Date.now()),
            }),
            listen: async (callback: typeof listener) => {
              listener = callback;
              return () => undefined;
            },
          },
        },
      ],
    });
    const service = TestBed.inject(DesktopAwarenessService);
    await service.start();
    expect(service.status()).toContain('No local Spotify session');
    vi.advanceTimersByTime(16_000);
    expect(service.status()).toContain('Spotify observation unavailable');
    listener(frame('2'));
    expect(service.status()).toContain('Spotify observation unavailable');
  });
  it('subscribes once, drops older snapshots, honors native pause and disposes resources', async () => {
    vi.useFakeTimers();
    let listener: (payload: unknown) => void = () => undefined;
    const stop = vi.fn();
    const invoke = vi.fn(async (command: string) =>
      command === 'awareness_set_enabled' ? frame('3', false) : frame(),
    );
    const transport: AwarenessTransport = {
      invoke,
      listen: async (callback) => {
        listener = callback;
        return stop;
      },
    };
    TestBed.configureTestingModule({
      providers: [{ provide: AWARENESS_TRANSPORT, useValue: transport }],
    });
    const service = TestBed.inject(DesktopAwarenessService);
    await service.start();
    await service.start();
    listener(frame('2'));
    listener(frame('1', false));
    expect(service.enabled()).toBe(true);
    await service.setEnabled(false);
    expect(service.status()).toBe('Awareness paused');
    service.workspace({ version: 1, epoch: '0', panes: [] });
    expect(invoke).toHaveBeenCalledTimes(2);
    TestBed.resetTestingModule();
    expect(stop).toHaveBeenCalledOnce();
    listener(frame('4'));
    expect(service.enabled()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('releases a subscription that arrives after destruction', async () => {
    let resolve: (stop: () => void) => void = () => undefined;
    const stop = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: AWARENESS_TRANSPORT,
          useValue: {
            invoke: vi.fn(),
            listen: () =>
              new Promise((done) => {
                resolve = done;
              }),
          },
        },
      ],
    });
    const service = TestBed.inject(DesktopAwarenessService);
    const started = service.start();
    TestBed.resetTestingModule();
    resolve(stop);
    await started;
    expect(stop).toHaveBeenCalledOnce();
  });
  it('reports failures and coalesces workspace updates without parallel invocations', async () => {
    const workspaceResolvers: Array<() => void> = [];
    const invoke = vi.fn<AwarenessTransport['invoke']>((command) =>
      command === 'awareness_workspace'
        ? new Promise<void>((done) => workspaceResolvers.push(done))
        : Promise.resolve(frame()),
    );
    TestBed.configureTestingModule({
      providers: [
        {
          provide: AWARENESS_TRANSPORT,
          useValue: { invoke, listen: async () => () => undefined },
        },
      ],
    });
    const service = TestBed.inject(DesktopAwarenessService);
    await service.start();
    service.workspace({ version: 1, epoch: '1', panes: [] });
    service.workspace({ version: 1, epoch: '2', panes: [] });
    service.workspace({ version: 1, epoch: '3', panes: [] });
    expect(workspaceResolvers).toHaveLength(1);
    workspaceResolvers[0]();
    await flush();
    expect(invoke.mock.calls.at(-1)?.[1]).toEqual({
      version: 1,
      epoch: '3',
      panes: [],
    });
    workspaceResolvers[1]();
    await flush();
  });
});
