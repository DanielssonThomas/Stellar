import type {
  WorkspaceLayoutNode,
  WorkspaceSplitAxis,
  WorkspaceSplitPlacement,
} from '@stellar/desktop-contracts';
import { plainRecord } from './stage-json';

export type StageTree = WorkspaceLayoutNode;
export const MAX_STAGE_PANES = 12;
export const treeIds = (tree: StageTree | null): string[] =>
  !tree
    ? []
    : tree.kind === 'pane'
      ? [tree.instance_id]
      : [...treeIds(tree.first), ...treeIds(tree.second)];

export function decodeStageTree(value: unknown): StageTree | null {
  const panes = new Set<string>(),
    splits = new Set<string>();
  const id = (v: unknown): v is string =>
    typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v);
  function visit(v: unknown, depth: number): StageTree | null {
    if (depth > 12 || !plainRecord(v)) return null;
    if (v['kind'] === 'pane') {
      if (
        Object.keys(v).length !== 2 ||
        !id(v['instance_id']) ||
        panes.has(v['instance_id'])
      )
        return null;
      panes.add(v['instance_id']);
      return panes.size <= MAX_STAGE_PANES
        ? Object.freeze({ kind: 'pane', instance_id: v['instance_id'] })
        : null;
    }
    if (
      v['kind'] !== 'split' ||
      Object.keys(v).length !== (Object.hasOwn(v, 'equal_panes') ? 7 : 6) ||
      (Object.hasOwn(v, 'equal_panes') &&
        typeof v['equal_panes'] !== 'boolean') ||
      !id(v['split_id']) ||
      splits.has(v['split_id']) ||
      !['horizontal', 'vertical'].includes(String(v['axis'])) ||
      !Number.isInteger(v['percent']) ||
      Number(v['percent']) < 10 ||
      Number(v['percent']) > 90
    )
      return null;
    splits.add(v['split_id']);
    const first = visit(v['first'], depth + 1),
      second = visit(v['second'], depth + 1);
    return first && second
      ? Object.freeze({
          kind: 'split',
          split_id: v['split_id'],
          axis: v['axis'] as WorkspaceSplitAxis,
          percent: Number(v['percent']),
          ...(typeof v['equal_panes'] === 'boolean'
            ? { equal_panes: v['equal_panes'] }
            : {}),
          first,
          second,
        })
      : null;
  }
  return visit(value, 0);
}

export function removeTreePane(
  tree: StageTree | null,
  id: string,
): StageTree | null {
  if (!tree || tree.kind === 'pane')
    return tree?.instance_id === id ? null : tree;
  const first = removeTreePane(tree.first, id),
    second = removeTreePane(tree.second, id);
  return first && second ? { ...tree, first, second } : (first ?? second);
}

export function mapTree(
  tree: StageTree,
  transform: (node: StageTree) => StageTree,
): StageTree {
  return transform(
    tree.kind === 'split'
      ? {
          ...tree,
          first: mapTree(tree.first, transform),
          second: mapTree(tree.second, transform),
        }
      : tree,
  );
}

export function splitTree(
  tree: StageTree,
  target: string,
  other: string,
  splitId: string,
  placement: WorkspaceSplitPlacement,
): StageTree | null {
  if (
    target === other ||
    !treeIds(tree).includes(target) ||
    !treeIds(tree).includes(other)
  )
    return null;
  const remaining = removeTreePane(tree, other);
  if (!remaining) return null;
  const left = placement === 'left' || placement === 'above';
  const pane: StageTree = { kind: 'pane', instance_id: other };
  const result = mapTree(remaining, (node) =>
    node.kind === 'pane' && node.instance_id === target
      ? {
          kind: 'split',
          split_id: splitId,
          axis:
            placement === 'left' || placement === 'right'
              ? 'vertical'
              : 'horizontal',
          percent: 50,
          first: left ? pane : node,
          second: left ? node : pane,
        }
      : node,
  );
  return decodeStageTree(result);
}

export function resizeTree(
  tree: StageTree,
  splitId: string,
  percent: number,
): StageTree | null {
  let found = false;
  const next = mapTree(tree, (node) => {
    if (node.kind !== 'split' || node.split_id !== splitId) return node;
    found = true;
    return { ...node, percent, equal_panes: false };
  });
  return found ? next : null;
}

export function automaticTree(
  ids: readonly string[],
  prefix = 'auto',
): StageTree | null {
  if (!ids.length) return null;
  if (ids.length === 1) return { kind: 'pane', instance_id: ids[0] };
  const count = Math.ceil(ids.length / 2);
  const first = automaticTree(ids.slice(0, count), prefix + 'a');
  const second = automaticTree(ids.slice(count), prefix + 'b');
  if (!first || !second) return null;
  return {
    kind: 'split',
    split_id: prefix,
    axis: prefix.length % 2 === 0 ? 'vertical' : 'horizontal',
    percent: Math.round((100 * count) / ids.length),
    first,
    second,
  };
}
