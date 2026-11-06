import { describe, it, expect } from 'vitest';
import { decodeIvyInspectorSnapshot } from './ivy-inspector-codec';

function snapshot() {
  return {
    version: 1,
    observed_at: '2026-11-06T20:00:00Z',
    active_session_id: 'runtime',
    active_stored_session_id: 'stored',
    selected_session_id: 'stored',
    history_available: true,
    sessions: [
      {
        id: 'stored',
        title: 'Current',
        model: 'terra',
        started_at: null,
        last_activity_at: null,
        message_count: 2,
      },
    ],
    next_offset: null,
    messages: [{ id: 1, role: 'user', text: 'Hello', at: null }],
    next_before: null,
    context: { observed_at: null, used: 10, limit: 100, compactions: 1 },
    account: {
      state: 'available',
      observed_at: null,
      windows: [
        {
          label: 'Session',
          used_percent: 25,
          reset_at: null,
          scope: 'account',
        },
      ],
    },
  };
}
describe('Ivy inspector wire decoder', () => {
  it('preserves source-backed current context and separate account quota', () => {
    const result = decodeIvyInspectorSnapshot(snapshot());
    expect(result.context.used).toBe(10);
    expect(result.account.windows[0].used_percent).toBe(25);
    expect(result.active_stored_session_id).toBe('stored');
  });
  it('rejects cross-session, duplicate, malformed and oversized data', () => {
    const cases = [
      { ...snapshot(), version: 2 },
      { ...snapshot(), selected_session_id: 'unknown' },
      {
        ...snapshot(),
        sessions: [...snapshot().sessions, ...snapshot().sessions],
      },
      {
        ...snapshot(),
        messages: [{ ...snapshot().messages[0], text: 'x'.repeat(2001) }],
      },
      { ...snapshot(), context: { ...snapshot().context, used: 101 } },
      {
        ...snapshot(),
        account: {
          ...snapshot().account,
          windows: [{ ...snapshot().account.windows[0], used_percent: NaN }],
        },
      },
      { ...snapshot(), observed_at: 'not-a-date' },
      { ...snapshot(), private: 'not permitted' },
    ];
    cases.forEach((value) =>
      expect(() => decodeIvyInspectorSnapshot(value)).toThrow(),
    );
  });
  it('keeps unavailable metrics null instead of manufacturing zeros', () => {
    const result = decodeIvyInspectorSnapshot({
      ...snapshot(),
      context: {
        observed_at: null,
        used: null,
        limit: null,
        compactions: null,
      },
      account: { state: 'unavailable', observed_at: null, windows: [] },
    });
    expect(result.context.used).toBeNull();
    expect(result.account.windows).toEqual([]);
  });
});
