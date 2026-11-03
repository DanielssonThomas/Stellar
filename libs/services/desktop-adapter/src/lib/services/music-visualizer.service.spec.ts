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
    service.setEnabled(false);
    service.setEnabled(true);
    resolve(frame('1', 'starting'));
    await flush();
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
    vi.advanceTimersByTime(351);
    expect(service.levels().level).toBe(0);
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
