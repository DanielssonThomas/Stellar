import { describe, expect, it } from 'vitest';
import { createStageRegistry } from './stage-registry';
import { decodePresentationText } from './presentation-decoders';
import { directStage } from './stage-director';

const payload = {
  title: 'Plan',
  blocks: [{ kind: 'checklist', items: [{ text: 'Review', checked: false }] }],
};
function setup() {
  const registry = createStageRegistry({ 'rich-text': decodePresentationText });
  let commandId = 0;
  const command = (operation: object) =>
    registry.dispatch({
      contractVersion: 1,
      commandId: ++commandId,
      ...operation,
    });
  for (const instanceId of ['a', 'b', 'c'])
    command({
      action: 'open',
      instanceId,
      surface: 'rich-text',
      payload,
      prominence: instanceId === 'a' ? 'primary' : 'secondary',
    });
  return {
    registry,
    command,
    layout: () =>
      directStage(
        { width: 1200, height: 800 },
        registry.snapshot(),
        undefined,
        false,
        registry.layout(),
      ),
  };
}
describe('interactive Stage workspace', () => {
  it.each(['__proto__', 'constructor', 'toString'])(
    'keeps valid prototype-shaped pane ID %s finite and resizable',
    (id) => {
      const registry = createStageRegistry({
        'rich-text': decodePresentationText,
      });
      let commandId = 0;
      const command = (data: object) =>
        registry.dispatch({
          contractVersion: 1,
          commandId: ++commandId,
          ...data,
        });
      for (const instanceId of [id, 'other'])
        command({
          action: 'open',
          instanceId,
          surface: 'rich-text',
          payload,
          prominence: 'secondary',
        });
      command({ action: 'resize', instanceId: id, percent: 65 });
      const layout = directStage(
        { width: 1100, height: 760 },
        registry.snapshot(),
        undefined,
        false,
        registry.layout(),
      );
      expect(
        layout.surfaces.every((p) =>
          [p.x, p.y, p.width, p.height].every(Number.isFinite),
        ),
      ).toBe(true);
      expect(layout.surfaces[0].width).toBeCloseTo(715);
      expect(Object.getPrototypeOf(registry.layout().weights)).toBeNull();
    },
  );
  it('selects without moving and swaps/reorders without replacing immutable content', () => {
    const { registry, command } = setup();
    const original = registry.snapshot()[0].payload;
    command({ action: 'focus', instanceId: 'b' });
    expect(registry.snapshot().map((p) => p.instanceId)).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(registry.layout().focusedId).toBe('b');
    command({ action: 'swap', instanceId: 'a', otherId: 'c' });
    expect(registry.snapshot().map((p) => p.instanceId)).toEqual([
      'c',
      'b',
      'a',
    ]);
    expect(registry.snapshot()[2].payload).toBe(original);
    command({ action: 'restore-layout' });
    expect(registry.snapshot().map((p) => p.instanceId)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });
  it('allocates requested area, constrains invalid sizes and restores the previous split', () => {
    const { registry, command, layout } = setup();
    const previous = layout().surfaces;
    expect(
      command({ action: 'resize', instanceId: 'a', percent: 65 }).status,
    ).toBe('applied');
    expect(
      layout().surfaces.find((p) => p.instanceId === 'a')?.width,
    ).toBeCloseTo(780);
    expect(
      command({ action: 'resize', instanceId: 'a', percent: 99 }).status,
    ).toBe('rejected');
    command({ action: 'restore-layout' });
    expect(layout().surfaces).toEqual(previous);
    command({ action: 'resize', instanceId: 'b', percent: 65 });
    const pane = layout().surfaces.find((p) => p.instanceId === 'b');
    if (!pane) throw Error('Missing pane');
    // Minimum dimensions constrain extreme secondary-pane requests on smaller windows.
    expect(pane.width).toBeGreaterThanOrEqual(220);
    expect(pane.height).toBeGreaterThanOrEqual(140);
    expect(registry.snapshot()).toHaveLength(3);
  });
  it('maximizes and restores without undoing content changes, and never resurrects closed panes', () => {
    const { registry, command, layout } = setup();
    command({ action: 'maximize', instanceId: 'b' });
    expect(layout().surfaces.map((p) => p.instanceId)).toEqual(['b']);
    registry.edit('a', { ...payload, title: 'User edit' });
    command({ action: 'close', instanceId: 'c' });
    command({ action: 'restore-layout' });
    expect(layout().surfaces.map((p) => p.instanceId)).toEqual(['a', 'b']);
    expect(registry.snapshot()[0].payload?.title).toBe('User edit');
    command({ action: 'minimize', instanceId: 'a' });
    expect(layout().surfaces).toHaveLength(1);
    command({ action: 'restore', instanceId: 'a' });
    expect(layout().surfaces).toHaveLength(2);
  });
  it('rejects stale assistant content after user edits and admits an inspected revision', () => {
    const { registry, command } = setup();
    const edited = {
      ...payload,
      blocks: [
        { kind: 'checklist', items: [{ text: 'Review', checked: true }] },
      ],
    };
    expect(registry.edit('a', edited).status).toBe('applied');
    const update = {
      action: 'update',
      instanceId: 'a',
      surface: 'rich-text',
      payload,
    };
    expect(command(update).reason).toBe('revision-conflict');
    expect(command({ ...update, expectedRevision: 0 }).reason).toBe(
      'revision-conflict',
    );
    expect(command({ ...update, expectedRevision: 1 }).status).toBe('applied');
    expect(registry.snapshot()[0].revision).toBe(2);
    expect(command({ ...update, expectedRevision: 1 }).reason).toBe(
      'revision-conflict',
    );
  });
  it('uses bounded checkpoints and fences sequence replays after clear/disposal', () => {
    const { registry, command } = setup();
    expect(
      command({ action: 'swap', instanceId: 'a', otherId: 'missing' }).status,
    ).toBe('rejected');
    command({ action: 'clear' });
    expect(command({ action: 'restore-layout' }).status).toBe('rejected');
    registry.dispose();
    expect(command({ action: 'focus', instanceId: 'a' }).reason).toBe(
      'disposed',
    );
  });
  it('preserves custom splits through minimization and makes a newly focused target visible', () => {
    const { registry, command, layout } = setup();
    command({ action: 'resize', instanceId: 'a', percent: 65 });
    const previous = layout().surfaces;
    command({ action: 'minimize', instanceId: 'a' });
    command({ action: 'restore', instanceId: 'a' });
    expect(layout().surfaces).toEqual(previous);
    command({ action: 'maximize', instanceId: 'a' });
    command({ action: 'focus', instanceId: 'b' });
    expect(registry.layout().maximizedId).toBeNull();
    expect(layout().surfaces).toHaveLength(3);
  });
});
