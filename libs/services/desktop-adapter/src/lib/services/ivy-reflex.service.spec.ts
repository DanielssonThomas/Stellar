import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IvyReflexService } from './ivy-reflex.service';

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};
const key = 'stellar.ivy-reflex.enabled';
const plan = (id: unknown) => ({
  version: 1,
  input_id: id,
  plan: {
    route: 'action',
    action_id: 'pane.safe',
    reply: 'Consider it handled.',
  },
});
function fixture(
  options: {
    configured?: boolean;
    infer?: (id: unknown) => Promise<unknown>;
    setting?: (enabled: boolean) => Promise<void>;
    prepare?: () => Promise<unknown>;
    route?: (text: string) => boolean;
  } = {},
) {
  const execute = vi.fn(async () => 'confirmed' as const);
  const invoke = vi.fn(
    async (command: string, args?: Record<string, unknown>) => {
      if (command === 'reflex_set_enabled')
        return options.setting?.(args?.['enabled'] as boolean);
      if (command === 'reflex_status')
        return { version: 1, configured: options.configured ?? true };
      if (command === 'reflex_prepare')
        return options.prepare
          ? options.prepare()
          : { version: 1, configured: true };
      if (command === 'reflex_media_snapshot') throw Error('No media device');
      if (command === 'reflex_route')
        return {
          version: 1,
          local:
            options.route?.((args?.['request'] as { text: string }).text) ??
            true,
        };
      if (command === 'reflex_cancel') return;
      if (command === 'reflex_infer') {
        const id = (args?.['request'] as { input_id: string }).input_id;
        return options.infer ? options.infer(id) : plan(id);
      }
      throw Error(command);
    },
  );
  vi.stubGlobal('__TAURI__', { core: { invoke } });
  const service = TestBed.inject(IvyReflexService);
  service.bind(
    () => ({
      context: '{}',
      actions: [
        {
          id: 'pane.safe',
          description: 'Focus the selected pane',
          valid: () => true,
          execute,
        },
      ],
    }),
    () => 'one',
  );
  return { service, invoke, execute };
}

describe('Ivy Reflex beta preference and admission', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.removeItem(key);
  });
  it('executes two-pane swaps without waiting for model readiness or media inspection', async () => {
    const ready = deferred<unknown>();
    const { service, invoke, execute } = fixture({
      prepare: () => ready.promise,
    });
    service.bind(
      () => ({
        context: '[]',
        actions: [
          {
            id: 'pane.swap_pair',
            description: 'Swap visible pair',
            valid: () => true,
            execute,
          },
        ],
      }),
      () => 'pair',
    );
    const outcome = await service.run(
      'swap the pane positions',
      crypto.randomUUID(),
    );
    expect(outcome.outcome).toBe('confirmed');
    expect(execute).toHaveBeenCalledOnce();
    const commands = invoke.mock.calls.map(([command]) => command);
    expect(commands).not.toContain('reflex_route');
    expect(commands).not.toContain('reflex_infer');
    expect(commands).not.toContain('reflex_media_snapshot');
    ready.resolve({ version: 1, configured: true });
  });
  it('warms the enabled model on construction without a request or action', async () => {
    const ready = deferred<unknown>();
    const { service, invoke, execute } = fixture({
      prepare: () => ready.promise,
    });
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('reflex_prepare'),
    );
    expect(service.status()).toBe('Starting');
    expect(
      invoke.mock.calls.some(
        ([c]) => c === 'reflex_infer' || c === 'reflex_media_snapshot',
      ),
    ).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    ready.resolve({ version: 1, configured: true });
    await vi.waitFor(() => expect(service.status()).toBe('Ready'));
  });
  it('switches Off immediately while startup is pending and ignores late readiness', async () => {
    const ready = deferred<unknown>();
    const { service, invoke, execute } = fixture({
      prepare: () => ready.promise,
    });
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('reflex_prepare'),
    );
    const request = service.run('Focus this pane', 'during-startup');
    service.setEnabled(false);
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('reflex_set_enabled', {
        enabled: false,
      }),
    );
    expect(service.status()).toBe('Disabled');
    ready.resolve({ version: 1, configured: true });
    expect(await request).toMatchObject({
      handled: true,
      outcome: 'cancelled',
    });
    expect(service.status()).toBe('Disabled');
    expect(execute).not.toHaveBeenCalled();
  });
  it('falls back when model warm-up fails and does not start after a rejected settings write', async () => {
    const failed = fixture({
      prepare: async () => ({ version: 1, configured: false }),
    });
    expect(
      (await failed.service.run('Focus it', 'warmup-failed')).handled,
    ).toBe(false);
    expect(failed.service.status()).toBe('Unavailable');
    TestBed.resetTestingModule();
    const rejected = fixture({
      setting: async () => {
        throw Error('Unavailable');
      },
    });
    expect(
      (await rejected.service.run('Focus it', 'settings-failed')).handled,
    ).toBe(false);
    expect(rejected.invoke.mock.calls.map(([name]) => name)).toEqual([
      'reflex_route',
      'reflex_set_enabled',
    ]);
  });
  it('does not reinterpret a stale pane target or session after waiting for startup', async () => {
    const ready = deferred<unknown>();
    const { service, invoke, execute } = fixture({
      prepare: () => ready.promise,
    });
    let pane = 'first',
      epoch = 'one';
    service.bind(
      () => ({ context: JSON.stringify({ pane }), actions: [] }),
      () => epoch,
    );
    const request = service.run('Close that pane', 'stale-startup');
    pane = 'second';
    ready.resolve({ version: 1, configured: true });
    expect((await request).outcome).toBe('rejected');
    expect(invoke.mock.calls.some(([c]) => c === 'reflex_infer')).toBe(false);
    const next = service.run('Close that pane', 'old-session');
    epoch = 'two';
    expect((await next).outcome).toBe('cancelled');
    expect(execute).not.toHaveBeenCalled();
  });
  it('rejects a replacement pane even when its compact visible context is identical', async () => {
    const ready = deferred<unknown>();
    const { service, invoke, execute } = fixture({
      prepare: () => ready.promise,
    });
    let instance = 'original';
    service.bind(
      () => {
        const original = instance;
        return {
          context: '{"title":"Notes","selected":true}',
          actions: [
            {
              id: 'pane.safe',
              description: 'Close selected Notes pane',
              valid: () => original === instance,
              execute,
            },
          ],
        };
      },
      () => 'one',
    );
    const request = service.run(
      'Close that pane',
      'replacement-during-startup',
    );
    instance = 'replacement';
    ready.resolve({ version: 1, configured: true });
    expect((await request).outcome).toBe('rejected');
    expect(invoke.mock.calls.some(([c]) => c === 'reflex_infer')).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });
  it('defaults on for validated configuration and confirms a local action', async () => {
    const { service, execute } = fixture();
    expect(service.status()).toBe('Starting');
    expect((await service.run('Focus this pane', 'typed-one')).outcome).toBe(
      'confirmed',
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(service.status()).toBe('Ready');
    expect(service.lastRoute()).toBe('Reflex · confirmed');
  });
  it('restores Off after restart and never probes or reasons when disabled', async () => {
    const first = fixture();
    await vi.waitFor(() => expect(first.service.status()).toBe('Ready'));
    first.service.setEnabled(false);
    expect(localStorage.getItem(key)).toBe('false');
    TestBed.resetTestingModule();
    const { service, invoke, execute } = fixture();
    expect(service.enabled()).toBe(false);
    expect(service.status()).toBe('Disabled');
    expect((await service.run('Skip it', 'spoken-off')).handled).toBe(false);
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('reflex_set_enabled', {
        enabled: false,
      }),
    );
    expect(invoke.mock.calls.map(([name]) => name)).toEqual([
      'reflex_set_enabled',
    ]);
    expect(execute).not.toHaveBeenCalled();
    expect(service.lastRoute()).toBe('Hermes · Reflex disabled');
  });
  it('falls back without inference or media reads when configuration is unavailable', async () => {
    const { service, invoke } = fixture({ configured: false });
    expect((await service.run('Skip it', 'missing')).handled).toBe(false);
    expect(service.status()).toBe('Unavailable');
    expect(invoke.mock.calls.map(([name]) => name)).toEqual([
      'reflex_route',
      'reflex_set_enabled',
      'reflex_status',
    ]);
  });
  it('fences a late model reply on Off with no action or cloud retry', async () => {
    const pending = deferred<unknown>();
    const { service, invoke, execute } = fixture({
      infer: () => pending.promise,
    });
    const result = service.run('Focus this pane', 'pending');
    await vi.waitFor(() =>
      expect(invoke.mock.calls.some(([c]) => c === 'reflex_infer')).toBe(true),
    );
    service.setEnabled(false);
    pending.resolve(plan('pending'));
    expect(await result).toMatchObject({ handled: true, outcome: 'cancelled' });
    expect(execute).not.toHaveBeenCalled();
    expect(service.status()).toBe('Disabled');
    expect(invoke).toHaveBeenCalledWith('reflex_cancel', {
      inputId: 'pending',
    });
  });
  it('retains an already-dispatched receipt and never falls back after Off', async () => {
    const { service } = fixture();
    const pending = deferred<'confirmed'>();
    const execute = vi.fn(() => pending.promise);
    service.bind(
      () => ({
        context: '{}',
        actions: [
          {
            id: 'pane.safe',
            description: 'Focus selected pane',
            valid: () => true,
            execute,
          },
        ],
      }),
      () => 'one',
    );
    const result = service.run('Focus it', 'dispatched');
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    service.setEnabled(false);
    pending.resolve('confirmed');
    expect(await result).toMatchObject({ handled: true, outcome: 'cancelled' });
    expect(service.events()).toHaveLength(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('serializes rapid Off/On transitions before allowing another request', async () => {
    const off = deferred<void>();
    const { service, invoke, execute } = fixture({
      setting: (enabled) => (enabled ? Promise.resolve() : off.promise),
    });
    await vi.waitFor(() => expect(service.status()).toBe('Ready'));
    service.setEnabled(false);
    service.setEnabled(true);
    const result = service.run('Focus it', 'after-toggle');
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('reflex_set_enabled', {
        enabled: false,
      }),
    );
    expect(execute).not.toHaveBeenCalled();
    off.resolve();
    expect((await result).outcome).toBe('confirmed');
    expect(
      invoke.mock.calls
        .filter(([c]) => c === 'reflex_set_enabled')
        .map(([, a]) => a?.['enabled']),
    ).toEqual([true, false, true]);
  });
  it('cancels admission when the preference changes during readiness checking', async () => {
    const { service, invoke } = fixture();
    const result = service.run('Focus it', 'starting');
    service.setEnabled(false);
    expect(await result).toMatchObject({ handled: true, outcome: 'cancelled' });
    expect(invoke.mock.calls.some(([c]) => c === 'reflex_infer')).toBe(false);
  });
  it('reports runtime unavailability and delegates instead of retrying an action', async () => {
    const { service, execute } = fixture({
      infer: async (id) => ({ version: 1, input_id: id, plan: null }),
    });
    expect((await service.run('Focus it', 'failed')).handled).toBe(false);
    expect(service.status()).toBe('Unavailable');
    expect(service.lastRoute()).toBe('Hermes · unavailable');
    expect(execute).not.toHaveBeenCalled();
  });
  it('keeps the session usable if preference storage is blocked', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw Error('blocked');
    });
    const { service } = fixture();
    expect((await service.run('Focus it', 'storage')).outcome).toBe(
      'confirmed',
    );
    expect(() => service.setEnabled(false)).not.toThrow();
    expect(service.status()).toBe('Disabled');
  });
  it('shows a recoverable notice if clipboard export is unavailable', async () => {
    const { service } = fixture();
    vi.spyOn(service, 'status').mockReturnValue('Ready');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn(async () => {
          throw Error('Permission denied');
        }),
      },
    });
    await service.copyDiagnostics();
    expect(service.diagnosticNotice()).toBe(
      'Clipboard unavailable. Try again.',
    );
  });
  it('delegates substantive requests before warm-up completes without reading media or inferring', async () => {
    const ready = deferred<unknown>();
    const { service, invoke, execute } = fixture({
      prepare: () => ready.promise,
      route: () => false,
    });
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('reflex_prepare'),
    );
    for (const text of [
      'Please show me my latest github issue',
      'Ivy, how are we doing today?',
    ]) {
      expect(await service.run(text, text)).toMatchObject({
        handled: false,
        outcome: 'hermes',
      });
      expect(invoke).toHaveBeenCalledWith('reflex_route', {
        request: expect.objectContaining({ text }),
      });
    }
    expect(
      invoke.mock.calls.some(([c]) =>
        [
          'reflex_infer',
          'reflex_media_snapshot',
          'reflex_media_execute',
        ].includes(c),
      ),
    ).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect(service.requests().at(-1)).toMatchObject({
      route: 'Terra',
      outcome: 'pending',
    });
    ready.resolve({ version: 1, configured: true });
  });
});
