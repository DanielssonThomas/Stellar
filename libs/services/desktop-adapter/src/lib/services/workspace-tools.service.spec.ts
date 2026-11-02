import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { WorkspaceToolReply } from '@stellar/desktop-contracts';
import { describe, expect, it, vi } from 'vitest';
import { initialIvySnapshot } from '../ivy/ivy-transport';
import { IvyAdapterService } from './ivy-adapter.service';
import {
  WORKSPACE_TOOL_TRANSPORT,
  WorkspaceToolsService,
} from './workspace-tools.service';

const turn = '00000000-0000-4000-8000-000000000001';
const request = {
  version: 1,
  request_id: '1234567890abcdef1234567890abcdef',
  epoch: '2',
  turn_id: turn,
  expires_at_ms: String(Date.now() + 15000),
  operation: { kind: 'clear' as const },
};

function fixture() {
  let deliver!: (value: unknown) => void;
  const state = signal({
    ...initialIvySnapshot(),
    workspace_epoch: '2',
    connection: 'ready' as const,
    turn: 'submitting' as const,
    turn_id: turn,
  });
  const ivy = { state, snapshot: vi.fn(async () => state()) };
  const reply = vi.fn<(reply: WorkspaceToolReply) => Promise<void>>(async () => undefined);
  const unlisten = vi.fn();
  const transport = {
    listen: vi.fn(async (callback: (value: unknown) => void) => {
      deliver = callback;
      return unlisten;
    }),
    reply,
  };
  TestBed.configureTestingModule({
    providers: [
      WorkspaceToolsService,
      { provide: IvyAdapterService, useValue: ivy },
      { provide: WORKSPACE_TOOL_TRANSPORT, useValue: transport },
    ],
  });
  return {
    service: TestBed.inject(WorkspaceToolsService),
    state,
    ivy,
    reply,
    unlisten,
    deliver: (value: unknown) => deliver(value),
  };
}

describe('workspace tool adapter', () => {
  it('delivers the full request synchronously only after an authoritative matching snapshot', async () => {
    const f = fixture();
    await vi.waitFor(() => expect(f.service.ready()).toBe(true));
    const handler = vi.fn((value) => {
      expect(f.service.isCurrent(value)).toBe(true);
      return { kind: 'applied' as const };
    });
    f.service.bind(handler);
    f.deliver(request);
    await vi.waitFor(() => expect(f.reply).toHaveBeenCalledOnce());
    expect(handler).toHaveBeenCalledWith(request);
    expect(f.reply).toHaveBeenCalledWith({
      version: 1,
      request_id: request.request_id,
      epoch: '2',
      turn_id: turn,
      outcome: { kind: 'applied' },
    });
    TestBed.resetTestingModule();
    expect(f.unlisten).toHaveBeenCalledOnce();
  });

  it('rejects a queued request if the foreground changes while snapshot is pending', async () => {
    const f = fixture();
    await vi.waitFor(() => expect(f.service.ready()).toBe(true));
    let resolve!: (value: ReturnType<typeof f.state>) => void;
    f.ivy.snapshot.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const handler = vi.fn(() => ({ kind: 'applied' as const }));
    f.service.bind(handler);
    f.deliver(request);
    f.state.update((state) => ({ ...state, workspace_epoch: '3' }));
    resolve(f.state());
    await vi.waitFor(() => expect(f.reply).toHaveBeenCalledOnce());
    expect(handler).not.toHaveBeenCalled();
    expect(f.reply.mock.calls[0][0].outcome).toEqual({ kind: 'rejected' });
    TestBed.resetTestingModule();
  });
  it('never invokes the handler when the native deadline passes during snapshot', async () => {
    const f = fixture();
    await vi.waitFor(() => expect(f.service.ready()).toBe(true));
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    let resolve!: (value: ReturnType<typeof f.state>) => void;
    f.ivy.snapshot.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const handler = vi.fn(() => ({ kind: 'applied' as const }));
    f.service.bind(handler);
    const deadline = now + 100;
    f.deliver({ ...request, expires_at_ms: String(deadline) });
    now = deadline;
    resolve(f.state());
    await vi.waitFor(() => expect(f.reply).toHaveBeenCalledOnce());
    expect(handler).not.toHaveBeenCalled();
    expect(f.reply.mock.calls[0][0].outcome).toEqual({ kind: 'rejected' });
    clock.mockRestore();
    TestBed.resetTestingModule();
  });

  it('ignores an initially expired request before fetching a snapshot', async () => {
    const f = fixture();
    await vi.waitFor(() => expect(f.service.ready()).toBe(true));
    const handler = vi.fn(() => ({ kind: 'applied' as const }));
    f.service.bind(handler);
    f.deliver({ ...request, expires_at_ms: String(Date.now() - 1) });
    await Promise.resolve();
    expect(f.ivy.snapshot).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    TestBed.resetTestingModule();
  });

});
