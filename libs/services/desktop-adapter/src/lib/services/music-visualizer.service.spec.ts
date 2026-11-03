import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MUSIC_TRANSPORT,
  MusicVisualizerService,
} from './music-visualizer.service';
import type { MusicTransport } from '../music/music-transport';

const frame = (sequence: string, status = 'capturing', level = 0.3) => ({
  version: 1,
  sequence,
  status,
  levels: { level, bass: level, mid: level, treble: level },
  tone: level > 0 ? 69 : null,
});
const flush = async () => {
  for (let n = 0; n < 12; n++) await Promise.resolve();
};

describe('local music visualizer', () => {
  let service: MusicVisualizerService;
  let callback: (payload: unknown) => void;
  let invoke: ReturnType<typeof vi.fn<MusicTransport['setEnabled']>>;
  let unsubscribe: ReturnType<typeof vi.fn<() => void>>;
  beforeEach(() => {
    let sequence = 0;
    unsubscribe = vi.fn();
    invoke = vi.fn(async (request) =>
      frame(String(++sequence), request.enabled ? 'starting' : 'idle', 0),
    );
    const transport: MusicTransport = {
      setEnabled: invoke,
      listen: async (listener) => {
        callback = listener;
        return unsubscribe;
      },
    };
    TestBed.configureTestingModule({
      providers: [
        MusicVisualizerService,
        { provide: MUSIC_TRANSPORT, useValue: transport },
      ],
    });
    service = TestBed.inject(MusicVisualizerService);
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('captures only after opt in, bounds sensitivities and rejects stale events', async () => {
    expect(invoke).not.toHaveBeenCalled();
    service.setEnabled(true);
    await flush();
    callback(frame('10'));
    service.setSensitivity('bass', 2);
    expect(service.levels().bass).toBe(0.6);
    service.setSensitivity('level', 20);
    expect(service.levels().bass).toBe(1);
    service.setSensitivity('level', NaN);
    expect(service.sensitivity().level).toBe(3);
    callback(frame('9', 'capturing', 1));
    expect(service.levels().mid).toBeCloseTo(0.9);
    service.setEnabled(false);
    callback(frame('11', 'capturing', 1));
    expect(service.levels().level).toBe(0);
    await flush();
    expect(invoke).toHaveBeenLastCalledWith({ version: 1, enabled: false });
  });

  it.each([
    {
      events: [frame('12', 'unavailable', 0)],
      reply: frame('10', 'starting', 0),
      enabled: false,
      level: 0,
      status: 'unavailable',
    },
    {
      events: [frame('12', 'capturing', 0.8), frame('11', 'capturing', 0.2)],
      reply: frame('10', 'starting', 0),
      enabled: true,
      level: 0.8,
      status: 'Listening',
    },
    {
      events: [frame('9', 'unavailable', 0)],
      reply: frame('10', 'capturing', 0.3),
      enabled: true,
      level: 0.3,
      status: 'Listening',
    },
  ])(
    'reconciles early startup events with the reply by sequence: $status/$level',
    async ({ events, reply, enabled, level, status }) => {
      let resolve!: (value: unknown) => void;
      invoke.mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      service.setEnabled(true);
      await flush();
      for (const event of events) callback(event);
      resolve(reply);
      await flush();
      expect(service.enabled()).toBe(enabled);
      expect(service.levels().level).toBe(level);
      expect(service.tone()).toBe(level > 0 ? 69 : null);
      expect(service.status()).toContain(status);
      if (enabled) {
        callback(frame('13', 'capturing', 0.6));
        expect(service.levels().level).toBe(0.6);
      }
    },
  );

  it('serializes a stop behind a pending start and cannot resurrect stale levels', async () => {
    let resolve!: (value: unknown) => void;
    invoke.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    service.setEnabled(true);
    await flush();
    callback(frame('50', 'capturing', 1));
    service.setEnabled(false);
    service.setEnabled(true);
    resolve(frame('1', 'starting'));
    await flush();
    expect(service.levels().level).toBe(0);
    expect(invoke.mock.calls.map((call) => call[0].enabled)).toEqual([
      true,
      false,
      true,
    ]);
    callback(frame('10', 'unavailable', 0));
    expect(service.enabled()).toBe(false);
    expect(service.levels().level).toBe(0);
  });

  it('decays lost frames and stops capture on hidden visibility and destruction', async () => {
    service.setEnabled(true);
    await flush();
    vi.useFakeTimers();
    callback(frame('10'));
    expect(service.levels().level).toBe(0.3);
    expect(service.tone()).toBe(69);
    vi.advanceTimersByTime(351);
    expect(service.levels().level).toBe(0);
    expect(service.tone()).toBeNull();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(service.enabled()).toBe(false);
    expect(invoke).toHaveBeenLastCalledWith({ version: 1, enabled: false });
    TestBed.resetTestingModule();
    await flush();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('contains optional capture errors without an unhandled rejection', async () => {
    invoke.mockRejectedValueOnce('unavailable');
    service.setEnabled(true);
    await flush();
    expect(service.enabled()).toBe(false);
    expect(service.status()).toContain('unavailable');
    service.setEnabled(true);
    await flush();
    callback({ ...frame('20'), levels: { level: Infinity } });
    await flush();
    expect(invoke).toHaveBeenLastCalledWith({ version: 1, enabled: false });
    expect(service.levels().level).toBe(0);
  });
});
