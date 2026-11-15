import { TestBed } from '@angular/core/testing';
import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  IvyInspectorService,
  IVY_INSPECTOR_READ,
} from './ivy-inspector.service';
import type { IvyInspectorRequest } from '@stellar/desktop-contracts';

function snapshot(id = 'current', next: number | null = 40) {
  return {
    version: 1,
    observed_at: '2026-11-06T20:00:00Z',
    active_session_id: 'current',
    active_stored_session_id: 'current',
    selected_session_id: id,
    history_available: true,
    sessions: [
      {
        id,
        title: id,
        model: 'terra',
        started_at: null,
        last_activity_at: null,
        message_count: 100,
      },
    ],
    next_offset: next,
    messages: [
      { id: id === 'current' ? 50 : 1, role: 'user', text: id, at: null },
    ],
    next_before: 40,
    context: { observed_at: null, used: 10, limit: 100, compactions: 1 },
    account: { state: 'unavailable', observed_at: null, windows: [] },
  };
}
function setup(read: (request: IvyInspectorRequest) => Promise<unknown>) {
  TestBed.configureTestingModule({
    providers: [{ provide: IVY_INSPECTOR_READ, useValue: read }],
  });
  return TestBed.inject(IvyInspectorService);
}
afterEach(() => {
  TestBed.resetTestingModule();
  vi.useRealTimers();
});
describe('Ivy inspector reads', () => {
  it('ignores stale transcript results after selection and never changes active session', async () => {
    let resolveFirst!: (value: unknown) => void;
    const read = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise((resolve) => (resolveFirst = resolve)),
      )
      .mockResolvedValue(snapshot('older'));
    const service = setup(read);
    const first = service.refresh();
    service.select('older');
    await vi.waitFor(() =>
      expect(service.snapshot()?.selected_session_id).toBe('older'),
    );
    resolveFirst(snapshot());
    await first;
    expect(service.messages()[0].text).toBe('older');
    expect(service.snapshot()?.active_session_id).toBe('current');
    expect(read.mock.calls[1][0].session_id).toBe('older');
  });
  it('refreshes newest data after paginating older sessions and messages', async () => {
    const read = vi.fn(async (request: IvyInspectorRequest) =>
      snapshot('current', request.offset ? null : 40),
    );
    const service = setup(read);
    await service.refresh();
    service.moreSessions();
    await vi.waitFor(() => expect(service.loading()).toBe(false));
    service.olderMessages();
    await vi.waitFor(() => expect(service.loading()).toBe(false));
    await service.refresh();
    expect(read.mock.calls.map((call) => call[0])).toEqual([
      { version: 1, session_id: null, offset: 0, before_message: null },
      { version: 1, session_id: null, offset: 40, before_message: null },
      { version: 1, session_id: null, offset: 0, before_message: 40 },
      { version: 1, session_id: null, offset: 0, before_message: null },
    ]);
  });
  it('stops refresh polling and fences in-flight data on close', async () => {
    vi.useFakeTimers();
    const read = vi.fn(async () => snapshot());
    const service = setup(read);
    service.open();
    await vi.advanceTimersByTimeAsync(5000);
    expect(read).toHaveBeenCalledTimes(3);
    service.close();
    await vi.advanceTimersByTimeAsync(10000);
    expect(read).toHaveBeenCalledTimes(3);
  });
  it('retains prior data with an explicit stale error on failed refresh', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(snapshot())
      .mockRejectedValueOnce(new Error());
    const service = setup(read);
    await service.refresh();
    await service.refresh();
    expect(service.error()).toContain('Session details unavailable');
    expect(service.snapshot()?.selected_session_id).toBe('current');
  });
});
