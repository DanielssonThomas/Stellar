import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import {
  createStageRegistry,
  STAGE_CATALOGUE,
  type StageCatalogue,
  type StageOrganism,
} from '@stellar/ui-organisms';
import type {
  WorkspaceToolOperation,
  WorkspaceToolRequest,
} from '@stellar/desktop-contracts';
import { desktopWorkspace } from './desktop-workspace';

function setup() {
  const catalogue: StageCatalogue = TestBed.inject(STAGE_CATALOGUE);
  const registry = createStageRegistry(
    Object.fromEntries(
      Object.entries(catalogue).map(([key, value]) => [key, value.decode]),
    ),
  );
  const stage = {
    nextCommandId: () => registry.nextCommandId(),
    inspectPresentations: () =>
      registry.snapshot().map((p, index) => ({
        ...p,
        title: 'Pane',
        selected: false,
        maximized: false,
        render_state: 'ready' as const,
        position: index,
        rect: null,
        viewport: { width: 1100, height: 760 },
      })),
  } as Pick<StageOrganism, 'nextCommandId' | 'inspectPresentations'>;
  const isCurrent = vi.fn(() => true),
    available = vi.fn(() => true),
    present = vi.fn(registry.dispatch);
  const handle = desktopWorkspace({ stage, isCurrent, available, present });
  const call = (operation: WorkspaceToolOperation) =>
    handle({
      version: 1,
      epoch: '2',
      request_id: 'request',
      turn_id: 'turn',
      expires_at_ms: String(Date.now() + 15000),
      operation,
    } as WorkspaceToolRequest);
  const open = {
    kind: 'open',
    instance_id: 'plan',
    surface: 'rich-text',
    prominence: 'primary',
    payload_json: JSON.stringify({
      title: 'Plan',
      blocks: [{ kind: 'paragraph', text: 'Private pane content' }],
    }),
  } as const;
  return { registry, isCurrent, available, present, call, open, stage };
}

describe('native workspace composition', () => {
  it('applies the whole batch before one settlement and returns ordered partial results with final metadata', async () => {
    const f = setup();
    let finish!: () => void;
    const settle = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    Object.assign(f.stage, { settlePresentations: settle });
    const result = f.call({
      kind: 'batch',
      operations: [
        f.open,
        { ...f.open, instance_id: 'reference' },
        { kind: 'focus', instance_id: 'missing' },
      ],
    });
    expect(f.registry.snapshot().map((pane) => pane.instanceId)).toEqual([
      'plan',
      'reference',
    ]);
    expect(settle).toHaveBeenCalledOnce();
    finish();
    expect(await result).toMatchObject({
      kind: 'batch',
      outcomes: ['applied', 'applied', 'rejected'],
      panes: [
        { instance_id: 'plan', render_state: 'ready' },
        { instance_id: 'reference', render_state: 'ready' },
      ],
    });
    settle.mockResolvedValueOnce(undefined);
    expect(
      await f.call({ kind: 'batch', operations: [{ kind: 'clear' }] }),
    ).toEqual({ kind: 'batch', outcomes: ['applied'], panes: [] });
    expect(f.registry.snapshot()).toEqual([]);
  });
  it('retains applied outcomes when ownership retires or an unexpected executor failure interrupts a batch', async () => {
    const f = setup();
    f.present.mockImplementationOnce((command) => {
      const result = f.registry.dispatch(command);
      f.isCurrent.mockReturnValue(false);
      return result;
    });
    expect(
      await f.call({
        kind: 'batch',
        operations: [f.open, { ...f.open, instance_id: 'second' }],
      }),
    ).toEqual({
      kind: 'batch',
      outcomes: ['applied', 'rejected'],
      panes: null,
    });
    expect(f.present).toHaveBeenCalledOnce();
    f.isCurrent.mockReturnValue(true);
    f.present.mockImplementationOnce(() => {
      throw Error('unavailable');
    });
    expect(
      await f.call({ kind: 'batch', operations: [{ kind: 'clear' }, f.open] }),
    ).toMatchObject({
      kind: 'batch',
      outcomes: ['uncertain', 'rejected'],
    });
    expect(f.present).toHaveBeenCalledTimes(2);
  });
  it('waits for renderer settlement and fences a retired owner before returning inspection', async () => {
    const f = setup();
    f.call(f.open);
    let finish!: () => void;
    const settle = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    Object.assign(f.stage, { settlePresentations: settle });
    const observation = f.call({ kind: 'inspect' });
    expect(settle).toHaveBeenCalledOnce();
    f.isCurrent.mockReturnValue(false);
    finish();
    expect(await observation).toEqual({ kind: 'rejected' });
    expect(f.present).toHaveBeenCalledOnce();
  });
  it('maps each assistant layout command to its exact Stage behavior', () => {
    const { call, open, registry, present } = setup();
    call(open);
    call({ ...open, instance_id: 'reference', prominence: 'secondary' });
    expect(call({ kind: 'minimize', instance_id: 'reference' })).toEqual({
      kind: 'applied',
    });
    expect(
      registry.snapshot().find((p) => p.instanceId === 'reference')?.minimized,
    ).toBe(true);
    expect(present).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'minimize' }),
    );
    call({ kind: 'restore', instance_id: 'reference' });
    expect(
      registry.snapshot().find((p) => p.instanceId === 'reference')?.minimized,
    ).toBe(false);
    expect(present).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'restore' }),
    );
    call({ kind: 'maximize', instance_id: 'reference' });
    expect(registry.layout().maximizedId).toBe('reference');
    call({ kind: 'restore_layout' });
    expect(registry.layout().maximizedId).toBeNull();
    call({ kind: 'resize', instance_id: 'plan', percent: 65 });
    expect(registry.layout().weights['plan']).toBe(0.65);
    call({ kind: 'swap', instance_id: 'plan', other_id: 'reference' });
    expect(registry.snapshot().map((p) => p.instanceId)).toEqual([
      'reference',
      'plan',
    ]);
  });
  it('uses the registered decoders and shared sequence for the complete pane lifecycle', () => {
    const { registry, call, open } = setup();
    expect(call(open)).toEqual({ kind: 'applied' });
    expect(
      call({ ...open, instance_id: 'reference', prominence: 'secondary' }),
    ).toEqual({ kind: 'applied' });
    expect(
      call({
        kind: 'update',
        instance_id: 'plan',
        surface: 'rich-text',
        payload_json:
          '{"title":"Updated","blocks":[{"kind":"paragraph","text":"Revised"}]}',
      }),
    ).toEqual({ kind: 'applied' });
    expect(call({ kind: 'focus', instance_id: 'reference' })).toEqual({
      kind: 'applied',
    });
    expect(
      call({ kind: 'arrange', instance_ids: ['plan', 'reference'] }),
    ).toEqual({ kind: 'applied' });
    const inspected = call({ kind: 'inspect' });
    expect(inspected).toMatchObject({
      kind: 'inspection',
      panes: [
        {
          instance_id: 'plan',
          surface: 'rich-text',
          prominence: 'primary',
          minimized: false,
        },
        {
          instance_id: 'reference',
          surface: 'rich-text',
          prominence: 'secondary',
          minimized: false,
        },
      ],
    });
    expect(JSON.stringify(inspected)).not.toContain('Revised');
    expect(call({ kind: 'remove', instance_id: 'reference' })).toEqual({
      kind: 'applied',
    });
    expect(call({ kind: 'clear' })).toEqual({ kind: 'applied' });
    expect(registry.snapshot()).toEqual([]);
    expect(registry.nextCommandId()).toBe(8);
  });
  it('rejects forged metrics, unsafe URLs, malformed JSON and renderer-side screenshots without mutation', () => {
    const { registry, call, open, present } = setup();
    expect(call({ ...open, payload_json: '{' })).toEqual({ kind: 'rejected' });
    expect(
      call({
        ...open,
        surface: 'workflow',
        payload_json: '{"title":"Fake","agents":[]}',
      }),
    ).toEqual({ kind: 'rejected' });
    expect(
      call({
        ...open,
        surface: 'browser',
        payload_json: '{"title":"Unsafe","url":"javascript:alert(1)"}',
      }),
    ).toEqual({ kind: 'rejected' });
    const calls = present.mock.calls.length;
    expect(call({ kind: 'capture_window' })).toEqual({ kind: 'rejected' });
    expect(call({ kind: 'capture_foreground' })).toEqual({ kind: 'rejected' });
    expect(call({ kind: 'capture_display', display_id: null })).toEqual({
      kind: 'rejected',
    });
    expect(call({ kind: 'list_displays' })).toEqual({ kind: 'rejected' });
    expect(present).toHaveBeenCalledTimes(calls);
    expect(registry.snapshot()).toEqual([]);
  });
  it('rechecks ownership immediately before mutation and rejects suspended desktops', () => {
    const { call, open, isCurrent, available, present } = setup();
    isCurrent.mockReturnValueOnce(true).mockReturnValueOnce(false);
    expect(call(open)).toEqual({ kind: 'rejected' });
    expect(present).not.toHaveBeenCalled();
    available.mockReturnValue(false);
    expect(call({ kind: 'inspect' })).toEqual({ kind: 'rejected' });
    expect(present).not.toHaveBeenCalled();
  });
});
