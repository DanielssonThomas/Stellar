import { describe, expect, it, vi } from 'vitest';
import {
  decodeActivitySummary,
  decodeStageCommand,
  ProductionPayloadMap,
  StageCommand,
} from './stage-contract';
import { createStageRegistry } from './stage-registry';

const catalogue = { 'activity-summary': decodeActivitySummary };
const open = (
  commandId = 1,
  instanceId = 'summary',
): StageCommand<ProductionPayloadMap> => ({
  contractVersion: 1,
  commandId,
  instanceId,
  action: 'open',
  surface: 'activity-summary',
  prominence: 'primary',
  payload: { durationMs: 1500, peakLevel: 0.5 },
});
const control = (
  commandId: number,
  action: 'focus' | 'minimize' | 'close',
  instanceId = 'summary',
) => ({ contractVersion: 1, commandId, instanceId, action });

describe('Stage command boundary and registry', () => {
  it.each([
    null,
    {},
    { ...open(), contractVersion: 2 },
    { ...open(), action: 'execute' },
    { ...open(), surface: 'remote-component' },
    { ...open(), template: '<script>' },
    { ...open(), commandId: NaN },
    { ...open(), commandId: 0 },
    { ...open(), instanceId: 'bad/id' },
    { ...open(), prominence: 'urgent' },
    { ...control(1, 'close'), payload: {} },
  ])('rejects malformed or unauthorized command %#', (input) => {
    expect(decodeStageCommand(input, catalogue)).toBeNull();
  });

  it.each([
    { durationMs: -1, peakLevel: 0.5 },
    { durationMs: 1, peakLevel: Infinity },
    { durationMs: 1, peakLevel: 1.1 },
    { durationMs: 1, peakLevel: 0.5, inputLabel: 'a'.repeat(81) },
    { durationMs: 1, peakLevel: 0.5, inputLabel: 'a\nb' },
    { durationMs: 1, peakLevel: 0.5, html: '<b>bad</b>' },
  ])('rejects invalid activity payload %#', (payload) => {
    expect(decodeActivitySummary(payload)).toBeNull();
  });

  it('rejects accessor/non-JSON/cyclic payloads without calling getters', () => {
    const getter = vi.fn(() => 1);
    const payload = { peakLevel: 0.5 };
    Object.defineProperty(payload, 'durationMs', {
      enumerable: true,
      get: getter,
    });
    expect(decodeStageCommand({ ...open(), payload }, catalogue)).toBeNull();
    expect(getter).not.toHaveBeenCalled();
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    for (const invalid of [
      cyclic,
      new Date(),
      { durationMs: undefined, peakLevel: 0.5 },
      { durationMs: 1, peakLevel: 0.5, [Symbol('hidden')]: true },
    ])
      expect(
        decodeStageCommand({ ...open(), payload: invalid }, catalogue),
      ).toBeNull();
  });

  it('enforces UTF8 payload bounds even for trusted extension decoders', () => {
    const extension = { fixture: (value: unknown) => value };
    const command = {
      ...open(),
      surface: 'fixture',
      payload: '界'.repeat(700),
    };
    expect(decodeStageCommand(command, extension)).toBeNull();
    expect(
      decodeStageCommand({ ...command, payload: new Array(2) }, extension),
    ).toBeNull();
    expect(
      decodeStageCommand(
        { ...command, payload: 'small' },
        { fixture: () => '界'.repeat(700) },
      ),
    ).toBeNull();
  });

  it('applies open/update/focus/minimize/close with detached immutable snapshots', () => {
    const registry = createStageRegistry(catalogue);
    const command = {
      ...open(),
      payload: { durationMs: 1500, peakLevel: 0.5 },
    };
    expect(registry.dispatch(command).status).toBe('applied');
    command.payload.durationMs = 9000;
    const first = registry.snapshot();
    expect(first[0].payload.durationMs).toBe(1500);
    expect(Object.isFrozen(first[0].payload)).toBe(true);
    expect(
      registry.dispatch({ ...open(2), action: 'update', prominence: undefined })
        .status,
    ).toBe('rejected');
    expect(
      registry.dispatch({
        contractVersion: 1,
        commandId: 2,
        instanceId: 'summary',
        action: 'update',
        surface: 'activity-summary',
        payload: { durationMs: 2500, peakLevel: 0.8 },
      }).status,
    ).toBe('applied');
    expect(registry.dispatch(control(3, 'minimize')).status).toBe('applied');
    expect(registry.snapshot()[0].minimized).toBe(true);
    registry.dispatch(open(4, 'second'));
    registry.dispatch(control(5, 'focus'));
    expect(registry.snapshot()[0].instanceId).toBe('summary');
    expect(registry.snapshot()[0].minimized).toBe(false);
    registry.dispatch(control(6, 'close'));
    expect(registry.snapshot().map((instance) => instance.instanceId)).toEqual([
      'second',
    ]);
    expect(first[0].payload.durationMs).toBe(1500);
  });

  it('deduplicates equal commands and rejects conflicts or stale evicted IDs', () => {
    const registry = createStageRegistry(catalogue);
    expect(registry.dispatch(open()).status).toBe('applied');
    expect(
      registry.dispatch({
        ...open(),
        payload: { peakLevel: 0.5, durationMs: 1500 },
      }).status,
    ).toBe('duplicate');
    expect(
      registry.dispatch({
        ...open(),
        payload: { durationMs: 999, peakLevel: 0.5 },
      }).reason,
    ).toBe('command-id-conflict');
    registry.dispatch(control(2, 'close'));
    for (let id = 3; id <= 70; id++)
      registry.dispatch(control(id, 'close', 'absent'));
    expect(registry.dispatch(open()).reason).toBe('stale-command');
    expect(registry.snapshot()).toEqual([]);
  });

  it('bounds instances and consumes valid failed attempts so they cannot execute later', () => {
    const registry = createStageRegistry(catalogue);
    for (let id = 1; id <= 4; id++) registry.dispatch(open(id, `item${id}`));
    expect(registry.dispatch(open(5, 'fifth')).reason).toBe('instance-limit');
    registry.dispatch(control(6, 'close', 'item1'));
    expect(registry.dispatch(open(5, 'fifth')).status).toBe('duplicate');
    expect(registry.snapshot()).toHaveLength(3);
    expect(registry.dispatch(open(7, 'item2')).reason).toBe('instance-exists');
  });

  it('keeps local dismissal available at the sequence ceiling and makes disposal terminal', () => {
    const registry = createStageRegistry(catalogue);
    registry.dispatch(open(Number.MAX_SAFE_INTEGER));
    expect(registry.interact('close', 'summary').status).toBe('applied');
    expect(registry.snapshot()).toEqual([]);
    registry.dispose();
    expect(registry.dispatch(open()).reason).toBe('disposed');
    expect(registry.interact('focus', 'summary').reason).toBe('disposed');
  });
});
