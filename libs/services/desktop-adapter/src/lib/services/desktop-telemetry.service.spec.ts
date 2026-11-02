import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DesktopTelemetryService,
  DESKTOP_TELEMETRY_TRANSPORT,
} from './desktop-telemetry.service';

const snapshot = (observedAt: string) => ({
  schemaVersion: 1,
  sequence: 1,
  observedAt,
  agents: [
    {
      id: 'architect',
      name: 'Architect',
      project: 'stellar',
      state: 'running',
      sessionId: 'abcdef0123456789',
      task: null,
      activity: 'Processing a turn',
      tool: null,
      model: null,
      provider: null,
      usage: null,
      startedAt: null,
      lastObservedAt: null,
      source: { kind: 'hermes-turn-lease', health: 'available', observedAt },
      events: [],
    },
  ],
});
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
afterEach(() => {
  TestBed.resetTestingModule();
  vi.useRealTimers();
});
describe('DesktopTelemetryService', () => {
  it('shares polling, masks stale activity, reports failure, reconnects and stops', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-02T12:00:00Z'));
    const read = vi
      .fn()
      .mockResolvedValueOnce(snapshot('2026-11-02T12:00:00Z'))
      .mockRejectedValueOnce(new Error())
      .mockResolvedValue(snapshot('2026-11-02T12:00:10Z'));
    TestBed.configureTestingModule({
      providers: [{ provide: DESKTOP_TELEMETRY_TRANSPORT, useValue: read }],
    });
    const service = TestBed.inject(DesktopTelemetryService);
    const releaseA = service.acquire(),
      releaseB = service.acquire();
    await flush();
    expect(read).toHaveBeenCalledTimes(1);
    expect(service.state().snapshot?.agents[0].state).toBe('running');
    await vi.advanceTimersByTimeAsync(5000);
    expect(service.state().status).toBe('unavailable');
    expect(service.state().snapshot?.agents[0].state).toBe('unknown');
    await vi.advanceTimersByTimeAsync(5000);
    expect(service.state().fresh).toBe(true);
    releaseA();
    releaseB();
    releaseB();
    await vi.advanceTimersByTimeAsync(10000);
    expect(read).toHaveBeenCalledTimes(3);
    expect(service.state().status).toBe('unavailable');
  });
  it('never overlaps requests or accepts late results after release', async () => {
    vi.useFakeTimers();
    let resolve!: (value: unknown) => void;
    const read = vi.fn(
      () =>
        new Promise<unknown>((r) => {
          resolve = r;
        }),
    );
    TestBed.configureTestingModule({
      providers: [{ provide: DESKTOP_TELEMETRY_TRANSPORT, useValue: read }],
    });
    const service = TestBed.inject(DesktopTelemetryService);
    const release = service.acquire();
    await vi.advanceTimersByTimeAsync(15000);
    expect(read).toHaveBeenCalledTimes(1);
    release();
    resolve(snapshot('2026-11-02T12:00:00Z'));
    await flush();
    expect(service.state().snapshot).toBeNull();
  });

  it('expires a live source at its observation deadline while a poll is pending', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-02T12:00:00Z'));
    const read = vi
      .fn()
      .mockResolvedValueOnce(snapshot('2026-11-02T12:00:00Z'))
      .mockImplementation(() => new Promise(() => undefined));
    TestBed.configureTestingModule({
      providers: [{ provide: DESKTOP_TELEMETRY_TRANSPORT, useValue: read }],
    });
    const service = TestBed.inject(DesktopTelemetryService);
    const release = service.acquire();
    await flush();
    await vi.advanceTimersByTimeAsync(9999);
    expect(service.state().snapshot?.agents[0].state).toBe('running');
    await vi.advanceTimersByTimeAsync(1);
    expect(service.state().snapshot?.agents[0].state).toBe('unknown');
    expect(service.state().snapshot?.agents[0].activity).toBeNull();
    release();
  });
});
