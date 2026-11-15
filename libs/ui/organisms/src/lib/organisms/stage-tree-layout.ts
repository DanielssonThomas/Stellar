import type { StageLayout, StageRect, StageDivider } from './stage-director';
import { type StageTree, treeIds } from './stage-tree';

export function treeMinimum(tree: StageTree): {
  width: number;
  height: number;
} {
  if (tree.kind === 'pane') return { width: 280, height: 180 };
  const a = treeMinimum(tree.first),
    b = treeMinimum(tree.second);
  return tree.axis === 'vertical'
    ? { width: a.width + b.width, height: Math.max(a.height, b.height) }
    : { width: Math.max(a.width, b.width), height: a.height + b.height };
}

export function tileTree(
  tree: StageTree,
  bounds: StageRect,
  dividers: StageDivider[],
): StageLayout['surfaces'] {
  if (tree.kind === 'pane')
    return [{ ...bounds, instanceId: tree.instance_id }];
  const vertical = tree.axis === 'vertical';
  const a = treeMinimum(tree.first),
    b = treeMinimum(tree.second);
  const dimension = vertical ? bounds.width : bounds.height;
  const firstMin = vertical ? a.width : a.height,
    secondMin = vertical ? b.width : b.height;
  const firstSize = Math.max(
    firstMin,
    Math.min(
      dimension - secondMin,
      dimension *
        (tree.equal_panes
          ? treeIds(tree.first).length / treeIds(tree).length
          : tree.percent / 100),
    ),
  );
  const first = {
    ...bounds,
    ...(vertical ? { width: firstSize } : { height: firstSize }),
  };
  const second = {
    ...bounds,
    ...(vertical
      ? { x: bounds.x + firstSize, width: dimension - firstSize }
      : { y: bounds.y + firstSize, height: dimension - firstSize }),
  };
  dividers.push({
    id: tree.split_id,
    axis: vertical ? 'x' : 'y',
    first: treeIds(tree.first),
    second: treeIds(tree.second),
    bounds,
    ratio: firstSize / dimension,
    minimum: firstMin / dimension,
    maximum: 1 - secondMin / dimension,
    x: vertical ? second.x - 4 : bounds.x,
    y: vertical ? bounds.y : second.y - 4,
    width: vertical ? 8 : bounds.width,
    height: vertical ? bounds.height : 8,
  });
  return [
    ...tileTree(tree.first, first, dividers),
    ...tileTree(tree.second, second, dividers),
  ];
}
