import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { server } from '@stellar/test-support';
import {
  LiveTelemetryService,
  type LiveSnapshot,
} from './live-telemetry.service';

class FakeStream {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  private snapshotListener?: EventListenerOrEventListenerObject;

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    if (type === 'snapshot') this.snapshotListener = listener;
  }

  emit(snapshot: LiveSnapshot) {
    const event = new MessageEvent('snapshot', {
      data: JSON.stringify(snapshot),
    });
    if (typeof this.snapshotListener === 'function')
      this.snapshotListener(event);
    else this.snapshotListener?.handleEvent(event);
  }

  close() {
    this.closed = true;
  }
}

function fixture(
  state: LiveSnapshot['agents'][number]['state'] = 'running',
): LiveSnapshot {
  const observedAt = new Date().toISOString();
  return {
    schemaVersion: 1,
    sequence: 1,
    observedAt,
    agents: [
      {
        id: 'designer',
        name: 'Designer',
        project: 'stellar-design',
        state,
        sessionId: 'opaque-session',
        task: null,
        activity: state === 'running' ? 'Editing files' : null,
        tool: state === 'running' ? 'Editing files' : null,
        model: null,
        provider: null,
        usage: null,
        startedAt: observedAt,
        lastObservedAt: observedAt,
        source: {
          kind: 'hermes-turn-lease',
          health: 'available',
          observedAt,
        },
        events: [
          {
            id: 'opaque-event',
            at: observedAt,
            kind: 'tool',
            label: 'Editing files',
          },
        ],
      },
    ],
  };
}

describe('LiveTelemetryService', () => {
  it('uses SSE, demotes running state on disconnect, and restores verified polling', async () => {
    const stream = new FakeStream();
    const service = new LiveTelemetryService();
    let unavailable = false;
    server.use(
      http.get('http://127.0.0.1:4212/api/live', () =>
        unavailable
          ? new HttpResponse(null, { status: 503 })
          : HttpResponse.json(fixture()),
      ),
    );
    service.start(() => stream as unknown as EventSource);
    await vi.waitFor(() => expect(service.agents()[0]?.state).toBe('running'));
    stream.onopen?.();
    expect(service.transport()).toBe('streaming');
    unavailable = true;
    stream.onerror?.();
    expect(service.agents()[0].state).toBe('unknown');
    expect(service.agents()[0].activity).toBeNull();
    await vi.waitFor(() => expect(service.transport()).toBe('unavailable'));
    unavailable = false;
    await service.refresh();
    expect(service.transport()).toBe('polling');
    expect(service.agents()[0].state).toBe('running');
    expect(service.agents()[0].task).toBeNull();
    service.stop();
    expect(stream.closed).toBe(true);
    expect(service.agents()[0].state).toBe('unknown');
  });

  it('expires stale activity and applies newer SSE lifecycle events', async () => {
    const stream = new FakeStream();
    const service = new LiveTelemetryService();
    server.use(
      http.get('http://127.0.0.1:4212/api/live', () =>
        HttpResponse.json(fixture()),
      ),
    );
    service.start(() => stream as unknown as EventSource);
    await vi.waitFor(() => expect(service.snapshot()).not.toBeNull());
    stream.onopen?.();
    service.now.set(Date.now() + 11_000);
    expect(service.agents()[0].state).toBe('unknown');
    const completed = { ...fixture('completed'), sequence: 2 };
    stream.emit(completed);
    expect(service.agents()[0].state).toBe('completed');
    expect(service.agents()[0].activity).toBeNull();
    service.stop();
  });

  it('accepts a newer observation after the local server resets its sequence', async () => {
    const stream = new FakeStream();
    const service = new LiveTelemetryService();
    server.use(
      http.get('http://127.0.0.1:4212/api/live', () =>
        HttpResponse.json({ ...fixture(), sequence: 10 }),
      ),
    );
    service.start(() => stream as unknown as EventSource);
    await vi.waitFor(() => expect(service.snapshot()?.sequence).toBe(10));
    stream.onopen?.();
    const current = service.snapshot();
    if (!current) throw new Error('Live fixture missing');
    stream.emit({
      ...fixture('completed'),
      sequence: 1,
      observedAt: new Date(
        Date.parse(current.observedAt) + 1_000,
      ).toISOString(),
    });
    expect(service.snapshot()?.sequence).toBe(1);
    expect(service.agents()[0].state).toBe('completed');
    stream.emit({ ...fixture(), sequence: 0, observedAt: current.observedAt });
    expect(service.snapshot()?.sequence).toBe(1);
    service.stop();
  });
});
