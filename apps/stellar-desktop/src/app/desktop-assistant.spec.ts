import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  initialIvySnapshot,
  IvyAdapterService,
} from '@stellar/service-desktop-adapter';
import type { IvySnapshot } from '@stellar/desktop-contracts';
import { DesktopAssistant } from './desktop-assistant';

function setup(available: () => boolean = () => true) {
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
  };
  TestBed.configureTestingModule({
    providers: [
      DesktopAssistant,
      { provide: IvyAdapterService, useValue: adapter },
    ],
  });
  const assistant = TestBed.inject(DesktopAssistant);
  const present = vi.fn(() => ({ status: 'applied' as const }));
  assistant.bind(present, available);
  TestBed.tick();
  return { assistant, adapter, state, present };
}

describe('desktop Ivy composition', () => {
  afterEach(() => TestBed.resetTestingModule());
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
    await assistant.reconcile();
    state.set({ ...state(), revision: '67', turn: 'completed' });
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
    await assistant.retry();
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
    await assistant.reconcile();
    expect(adapter.reconcile).toHaveBeenCalledOnce();
    expect(present).not.toHaveBeenCalled();
  });
});
