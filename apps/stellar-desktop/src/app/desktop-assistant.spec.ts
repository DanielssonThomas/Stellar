import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  initialIvySnapshot,
  IvyAdapterService,
  IvyReflexService,
} from '@stellar/service-desktop-adapter';
import type {
  IvyResponseSegment,
  IvySnapshot,
} from '@stellar/desktop-contracts';
import type { StageCommand, ProductionPayloadMap } from '@stellar/ui-organisms';
import { DesktopAssistant } from './desktop-assistant';

function setup(
  available: () => boolean = () => true,
  activities: () => readonly string[] = () => [],
) {
  const state = signal<IvySnapshot>({
    ...initialIvySnapshot(),
    connection: 'ready',
  });
  const adapter = {
    state,
    submit: vi.fn<(text: string, id: string) => Promise<IvySnapshot>>(
      async () => state(),
    ),
    connect: vi.fn(async () => state()),
    cancel: vi.fn(async () => state()),
    reconcile: vi.fn(async () => state()),
    snapshot: vi.fn(async () => state()),
  };
  TestBed.configureTestingModule({
    providers: [
      DesktopAssistant,
      { provide: IvyAdapterService, useValue: adapter },
    ],
  });
  const assistant = TestBed.inject(DesktopAssistant);
  const present = vi.fn<
    (command: StageCommand<ProductionPayloadMap>) => { status: 'applied' }
  >(() => ({ status: 'applied' }));
  assistant.bind(present, available, activities);
  TestBed.tick();
  return { assistant, adapter, state, present };
}

describe('desktop Ivy composition', () => {
  afterEach(() => TestBed.resetTestingModule());

  const commentary: IvyResponseSegment = {
    id: 'a'.repeat(64),
    kind: 'commentary',
    text: 'I found the calendar.',
    sequence: '1',
    reused: false,
  };

  it('replaces interim text with the canonical completed answer if native final is absent', () => {
    const { assistant, state } = setup();
    state.set({
      ...state(),
      turn: 'admitted',
      response_segments: [commentary],
    });
    expect(assistant.caption()).toEqual({
      text: commentary.text,
      kind: 'commentary',
    });

    const text = '`Standup` is at nine.';
    state.set({
      ...state(),
      turn: 'completed',
      items: [{ kind: 'text', text }],
    });
    expect(assistant.caption()).toEqual({
      text: 'Standup is at nine.',
      kind: 'final',
    });
  });

  it('prefers a native final caption even when its text was already narrated as commentary', () => {
    const { assistant, state } = setup();
    state.set({
      ...state(),
      turn: 'completed',
      items: [{ kind: 'text', text: 'Canonical fallback.' }],
      response_segments: [
        commentary,
        {
          ...commentary,
          id: 'b'.repeat(64),
          kind: 'final',
          sequence: null,
          reused: true,
        },
      ],
    });
    expect(assistant.caption()).toEqual({
      text: commentary.text,
      kind: 'final',
    });
  });

  it('clears interim text on completion when there is no eligible final caption', () => {
    const { assistant, state } = setup();
    state.set({
      ...state(),
      turn: 'admitted',
      response_segments: [commentary],
    });
    expect(assistant.caption().text).toBe(commentary.text);
    state.set({ ...state(), turn: 'completed' });
    expect(assistant.caption()).toEqual({ text: '', kind: 'final' });
    state.set({
      ...state(),
      items: [{ kind: 'text', text: '```json\n{}\n```' }],
    });
    expect(assistant.caption()).toEqual({ text: '', kind: 'final' });
  });

  it('shows an authoritative recovered cloud receipt after uncertainty and ignores stale terminal events', async () => {
    const { assistant, adapter, state } = setup();
    await assistant.submit('Show my issue');
    const id = adapter.submit.mock.calls[0][1];
    const reflex = TestBed.inject(IvyReflexService);
    state.set({ ...state(), revision: '2', turn_id: id, turn: 'uncertain' });
    TestBed.tick();
    expect(reflex.requests().at(-1)?.outcome).toBe('uncertain');
    state.set({ ...state(), revision: '3', turn: 'completed' });
    TestBed.tick();
    expect(reflex.requests().at(-1)).toMatchObject({ outcome: 'completed' });
    expect(reflex.requests().at(-1)?.steps.at(-1)?.label).toBe(
      'Response recovered',
    );
    state.set({ ...state(), revision: '2', turn: 'failed' });
    TestBed.tick();
    expect(reflex.requests().at(-1)?.outcome).toBe('completed');
    expect(adapter.submit).toHaveBeenCalledOnce();
  });
  it('records observed cloud stages under the original request and fences stale or terminal updates', async () => {
    const { assistant, state } = setup();
    const reflex = TestBed.inject(IvyReflexService);
    await assistant.submit(
      'Please show me my latest github issue',
      '11111111-1111-4111-8111-111111111111',
      'voice',
    );
    state.set({
      ...state(),
      revision: '1',
      turn_id: '11111111-1111-4111-8111-111111111111',
      turn: 'admitted',
    });
    TestBed.tick();
    expect(reflex.requests().at(-1)).toMatchObject({
      route: 'Terra',
      outcome: 'pending',
      source: 'voice',
    });
    expect(reflex.requests().at(-1)?.steps.at(-1)?.label).toBe(
      'Reasoning and tools',
    );
    state.set({ ...state(), revision: '2', turn: 'cancelled' });
    TestBed.tick();
    state.set({ ...state(), revision: '1', turn: 'completed' });
    TestBed.tick();
    expect(reflex.requests().at(-1)?.outcome).toBe('cancelled');
    reflex.clear();
    state.set({ ...state(), revision: '3', turn: 'completed' });
    TestBed.tick();
    expect(reflex.requests()).toEqual([]);
  });
  it('preserves blank and 8 KiB user input boundaries when local events are pending', async () => {
    const { assistant, adapter } = setup();
    const reflex = TestBed.inject(IvyReflexService);
    vi.spyOn(reflex, 'events').mockReturnValue([
      {
        action: 'media.next',
        target: 'Next track',
        outcome: 'confirmed',
        reply: 'Much better.',
      },
    ]);
    const acknowledge = vi.spyOn(reflex, 'acknowledgeEvents');
    expect(await assistant.submit('  ')).toBe(false);
    expect(adapter.submit).not.toHaveBeenCalled();
    const text = 'x'.repeat(8192);
    expect(await assistant.submit(text)).toBe(true);
    expect(adapter.submit).toHaveBeenCalledWith(
      text,
      expect.any(String),
      reflex.events(),
    );
    expect(acknowledge).toHaveBeenCalledWith(reflex.events());
  });
  it('waits for authoritative recovery rather than queue acceptance', async () => {
    vi.useFakeTimers();
    const { assistant, state, adapter } = setup();
    state.set({ ...state(), revision: '5', turn: 'uncertain' });
    const pending = assistant.reconcile();
    await Promise.resolve();
    await Promise.resolve();
    expect(assistant.recovery()).toBe('checking');
    expect(assistant.status()).toContain('Checking');
    await vi.advanceTimersByTimeAsync(250);
    expect(assistant.recovery()).toBe('checking');
    state.set({ ...state(), revision: '7', turn: 'completed' });
    await vi.advanceTimersByTimeAsync(250);
    await pending;
    expect(assistant.recovery()).toBe('recovered');
    expect(adapter.submit).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('reports unchanged on timeout and failed on a later authoritative error', async () => {
    vi.useFakeTimers();
    const { assistant, state } = setup();
    state.set({ ...state(), revision: '2', turn: 'uncertain' });
    const pending = assistant.reconcile();
    await vi.advanceTimersByTimeAsync(20000);
    await pending;
    expect(assistant.recovery()).toBe('unchanged');
    expect(assistant.status()).toContain('remains uncertain');
    const retry = assistant.reconcile();
    await Promise.resolve();
    await Promise.resolve();
    state.set({
      ...state(),
      revision: '4',
      connection: 'unavailable',
      error: 'protocol',
    });
    await vi.advanceTimersByTimeAsync(250);
    await retry;
    expect(assistant.recovery()).toBe('failed');
    expect(assistant.status()).toContain('failed');
    vi.useRealTimers();
  });

  it('cancels a pending bounded recovery on destruction', async () => {
    vi.useFakeTimers();
    const { assistant, state } = setup();
    state.set({ ...state(), turn: 'uncertain' });
    const pending = assistant.reconcile();
    TestBed.resetTestingModule();
    await pending;
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it('closes only activities captured by the explicit turn, once, even after replay', async () => {
    let activities = ['current', 'minimized'];
    const { assistant, adapter, state, present } = setup(
      () => true,
      () => activities,
    );
    await assistant.submit('Close this activity');
    const id = adapter.submit.mock.calls[0][1];
    activities = ['newer-content'];
    state.set({
      ...state(),
      revision: '1',
      turn: 'completed',
      turn_id: id,
      items: [{ kind: 'text', text: 'Closed' }, { kind: 'close_activity' }],
    });
    TestBed.tick();
    expect(present.mock.calls.map(([command]) => command)).toEqual([
      {
        contractVersion: 1,
        commandId: 1,
        instanceId: 'current',
        action: 'close',
      },
      {
        contractVersion: 1,
        commandId: 2,
        instanceId: 'minimized',
        action: 'close',
      },
    ]);
    state.set({ ...state(), revision: '2' });
    TestBed.tick();
    expect(present).toHaveBeenCalledTimes(2);
    expect(assistant.reply()).toBe('Closed');
  });
  it('clears waiting for cancellation, approval, uncertain, failure and completion', async () => {
    const { assistant, state } = setup();
    state.set({ ...state(), turn: 'admitted' });
    expect(assistant.waiting()).toBe(true);
    for (const turn of [
      'completed',
      'failed',
      'cancelled',
      'uncertain',
    ] as const) {
      state.set({ ...state(), turn });
      expect(assistant.waiting()).toBe(false);
    }
    state.set({ ...state(), turn: 'admitted', error: 'approval_required' });
    expect(assistant.waiting()).toBe(false);
    state.set({ ...state(), error: null });
    expect(assistant.waiting()).toBe(true);
    await assistant.cancel();
    expect(assistant.waiting()).toBe(false);
  });
  it('accepts a voice collectors stable UUID through the same eligibility path', async () => {
    const { assistant, adapter } = setup();
    const id = '00000000-0000-0000-0000-000000000001';
    expect(await assistant.submit('Locally transcribed text', id)).toBe(true);
    expect(adapter.submit).toHaveBeenCalledExactlyOnceWith(
      'Locally transcribed text',
      id,
    );
    expect(await assistant.submit('Duplicate utterance', id)).toBe(false);
    expect(adapter.submit).toHaveBeenCalledOnce();
  });
  it('cannot restore expired presentation eligibility through receipt replay', async () => {
    const { assistant, adapter, state, present } = setup();
    let first = '';
    for (let index = 0; index < 65; index++) {
      await assistant.submit('Show requested content');
      const id = adapter.submit.mock.calls[index][1];
      if (!index) first = id;
      state.set({
        ...state(),
        revision: String(index + 1),
        turn: 'completed',
        turn_id: id,
        items: [
          {
            kind: 'component',
            component: 'assistant_message',
            title: 'Requested',
            body: 'Body',
          },
        ],
      });
      TestBed.tick();
    }
    expect(present).toHaveBeenCalledTimes(65);
    state.set({
      ...state(),
      revision: '66',
      turn: 'uncertain',
      turn_id: first,
    });
    TestBed.tick();
    vi.useFakeTimers();
    const recovery = assistant.reconcile();
    await Promise.resolve();
    await Promise.resolve();
    state.set({ ...state(), revision: '67', turn: 'completed' });
    await vi.advanceTimersByTimeAsync(250);
    await recovery;
    vi.useRealTimers();
    TestBed.tick();
    expect(present).toHaveBeenCalledTimes(65);
  });
  it('defers completed content while suspended and releases its observer on destruction', async () => {
    const available = signal(false);
    const { assistant, adapter, state, present } = setup(available);
    await assistant.submit('Show after resume');
    const id = adapter.submit.mock.calls[0][1];
    state.set({
      ...state(),
      revision: '1',
      turn: 'completed',
      turn_id: id,
      items: [
        {
          kind: 'component',
          component: 'assistant_message',
          title: 'Requested',
          body: 'Deferred',
        },
      ],
    });
    TestBed.tick();
    expect(present).not.toHaveBeenCalled();
    available.set(true);
    TestBed.tick();
    expect(present).toHaveBeenCalledOnce();
    TestBed.resetTestingModule();
    state.set({ ...state(), revision: '2' });
    expect(present).toHaveBeenCalledOnce();
  });
  it('is silent until explicit input and keeps ordinary text out of Stage', async () => {
    const { assistant, adapter, state, present } = setup();
    expect(adapter.connect).not.toHaveBeenCalled();
    expect(adapter.submit).not.toHaveBeenCalled();
    state.set({
      ...state(),
      revision: '1',
      turn: 'completed',
      turn_id: 'recovered',
      items: [
        {
          kind: 'component',
          component: 'assistant_message',
          title: 'Old',
          body: 'History',
        },
      ],
    });
    TestBed.tick();
    expect(present).not.toHaveBeenCalled();
    await assistant.submit('Hello Ivy');
    const id = adapter.submit.mock.calls[0][1];
    expect(id).toMatch(/^[a-f0-9-]{36}$/);
    state.set({
      ...state(),
      revision: '2',
      turn_id: id,
      items: [{ kind: 'text', text: 'Normal answer' }],
    });
    TestBed.tick();
    expect(assistant.reply()).toBe('Normal answer');
    expect(present).not.toHaveBeenCalled();
  });
  it('presents completed explicit components once and rejects stale or replayed completions after close', async () => {
    const { assistant, adapter, state, present } = setup();
    await assistant.submit('Show a message');
    const id = adapter.submit.mock.calls[0][1];
    const snapshot: IvySnapshot = {
      ...state(),
      revision: '3',
      turn: 'completed',
      turn_id: id,
      items: [
        {
          kind: 'component',
          component: 'assistant_message',
          title: 'Requested',
          body: '<b>plain</b>',
        },
      ],
    };
    state.set(snapshot);
    TestBed.tick();
    expect(present).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        surface: 'assistant-message',
        payload: { title: 'Requested', body: '<b>plain</b>' },
      }),
    );
    state.set({ ...snapshot, revision: '4' });
    TestBed.tick();
    state.set({ ...snapshot, revision: '2' });
    TestBed.tick();
    expect(present).toHaveBeenCalledOnce();
  });
  it('exposes failure and uncertain recovery without automatically repeating a request', async () => {
    vi.useFakeTimers();
    const { assistant, adapter, state, present } = setup();
    state.set({
      ...state(),
      revision: '1',
      turn: 'failed',
      error: 'turn_failed',
    });
    TestBed.tick();
    expect(assistant.status()).toContain('request failed');
    state.set({
      ...state(),
      revision: '2',
      connection: 'unavailable',
      turn: 'idle',
      error: 'unavailable',
    });
    TestBed.tick();
    const connect = assistant.retry();
    await vi.advanceTimersByTimeAsync(20000);
    await connect;
    expect(adapter.connect).toHaveBeenCalledOnce();
    expect(adapter.submit).not.toHaveBeenCalled();
    state.set({
      ...state(),
      revision: '3',
      turn: 'uncertain',
      turn_id: 'existing',
    });
    TestBed.tick();
    await assistant.submit('Do not resend');
    expect(adapter.submit).not.toHaveBeenCalled();
    const check = assistant.reconcile();
    await vi.advanceTimersByTimeAsync(20000);
    await check;
    expect(adapter.reconcile).toHaveBeenCalledOnce();
    expect(present).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
