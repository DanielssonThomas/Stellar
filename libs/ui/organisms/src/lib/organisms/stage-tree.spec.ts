import { describe, it, expect } from 'vitest';
import { createStageRegistry } from './stage-registry';
import {
  decodePresentationText,
  decodePresentationBrowser,
} from './presentation-decoders';
import { directStage } from './stage-director';
import { decodeStageTree, type StageTree, treeIds } from './stage-tree';

const pane = (instance_id: string): StageTree => ({
  kind: 'pane',
  instance_id,
});
const split = (
  split_id: string,
  first: StageTree,
  second: StageTree,
  percent = 50,
  axis: 'horizontal' | 'vertical' = 'horizontal',
): StageTree => ({
  kind: 'split',
  split_id,
  first,
  second,
  percent,
  axis,
  equal_panes: true,
});
const six = split(
  'main',
  split('left', pane('a'), split('left-rest', pane('b'), pane('c')), 33),
  split('right', pane('d'), split('right-rest', pane('e'), pane('f')), 33),
  50,
  'vertical',
);

describe('targeted persistent layouts', () => {
  function setup() {
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
    for (const instanceId of ['a', 'b', 'c', 'd', 'e', 'f'])
      expect(
        command({
          action: 'open',
          instanceId,
          surface: 'rich-text',
          prominence: 'secondary',
          payload: {
            title: instanceId,
            blocks: [{ kind: 'paragraph', text: 'Retained content' }],
          },
        }).status,
      ).toBe('applied');
    return {
      registry,
      command,
      layout: (width = 1200, height = 900) =>
        directStage(
          { width, height },
          registry.snapshot(),
          'docked',
          false,
          registry.layout(),
        ),
    };
  }
  it('lets users resize an automatically created six-pane canvas without rebuilding content', () => {
    const { registry, layout } = setup();
    const divider = layout().dividers[0];
    const before = layout().surfaces;
    registry.resizeGroup(divider.first, divider.second, 0.6, divider.id);
    expect(registry.layout().tree).not.toBeNull();
    expect(layout().surfaces).not.toEqual(before);
    expect(registry.snapshot()).toHaveLength(6);
  });
  it('renders six useful boxes, preserves geometry through edits and restores minimized/maximized content', () => {
    const { registry, command, layout } = setup();
    expect(command({ action: 'set-layout', tree: six }).status).toBe('applied');
    const before = layout();
    expect(before.surfaces).toHaveLength(6);
    for (const rect of before.surfaces) {
      expect(rect.width).toBe(600);
      expect(rect.height).toBe(300);
    }
    registry.edit('a', {
      title: 'Changed',
      blocks: [{ kind: 'paragraph', text: 'User edit' }],
    });
    expect(layout().surfaces).toEqual(before.surfaces);
    registry.interact('minimize', 'b');
    expect(layout().surfaces).toHaveLength(5);
    registry.interact('restore', 'b');
    expect(layout().surfaces).toEqual(before.surfaces);
    command({ action: 'maximize', instanceId: 'a' });
    expect(layout().surfaces).toHaveLength(1);
    command({ action: 'restore-layout' });
    expect(layout().surfaces).toEqual(before.surfaces);
    expect(
      registry.snapshot().find((p) => p.instanceId === 'a')?.revision,
    ).toBe(1);
    const small = layout(400, 300);
    expect(small.canvas).toEqual({ width: 560, height: 540 });
    for (const rect of small.surfaces) {
      expect(rect.width).toBeGreaterThanOrEqual(280);
      expect(rect.height).toBeGreaterThanOrEqual(180);
    }
  });
  it('moves retained panes, targets a split, makes it equal and undoes without losing revisions', () => {
    const { registry, command } = setup();
    command({ action: 'set-layout', tree: six });
    const content = registry.snapshot().find((p) => p.instanceId === 'f');
    expect(
      command({
        action: 'split-pane',
        instanceId: 'a',
        otherId: 'f',
        splitId: 'new',
        placement: 'below',
      }).status,
    ).toBe('applied');
    expect(treeIds(registry.layout().tree)).toEqual([
      'a',
      'f',
      'b',
      'c',
      'd',
      'e',
    ]);
    expect(registry.snapshot().find((p) => p.instanceId === 'f')).toEqual(
      content,
    );
    command({ action: 'resize-split', splitId: 'new', percent: 70 });
    expect(JSON.stringify(registry.layout().tree)).toContain('"percent":70');
    command({ action: 'resize-split', splitId: 'new', percent: 50 });
    expect(JSON.stringify(registry.layout().tree)).not.toContain(
      '"percent":70',
    );
    command({ action: 'restore-layout' });
    expect(JSON.stringify(registry.layout().tree)).toContain('"percent":70');
    const before = registry.layout().tree;
    expect(command({ action: 'set-layout', tree: pane('a') }).status).toBe(
      'rejected',
    );
    expect(registry.layout().tree).toEqual(before);
  });
  it('rejects duplicate leaves, split IDs, unknown fields, invalid ratios and injected typography', () => {
    expect(decodeStageTree(split('bad', pane('a'), pane('a')))).toBeNull();
    expect(
      decodeStageTree(
        split('bad', pane('a'), split('bad', pane('b'), pane('c'))),
      ),
    ).toBeNull();
    expect(decodeStageTree({ ...six, script: 'bad' })).toBeNull();
    expect(decodeStageTree({ ...six, percent: 0 })).toBeNull();
    expect(
      decodePresentationText({
        blocks: [{ kind: 'markdown', text: '# Heading' }],
        typography: { family: 'url(bad)' },
      }),
    ).toBeNull();
    expect(
      decodePresentationText({
        blocks: [{ kind: 'markdown', text: '# Heading' }],
        typography: { fontSize: 999 },
      }),
    ).toBeNull();
    expect(
      decodePresentationBrowser({ url: 'https://example.com', chrome: false }),
    ).toEqual({
      kind: 'browser',
      title: '',
      url: 'https://example.com/',
      chrome: false,
    });
  });
});
