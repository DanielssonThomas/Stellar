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
    inspectPresentations: () => registry.snapshot(),
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
  return { registry, isCurrent, available, present, call, open };
}

describe('native workspace composition', () => {
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
    expect(inspected).toEqual({
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
