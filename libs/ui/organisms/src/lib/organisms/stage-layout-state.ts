import {
  type StageTree,
  removeTreePane,
  mapTree,
  treeIds,
  automaticTree,
} from './stage-tree';
export type LayoutPane = {
  readonly instanceId: string;
  readonly minimized: boolean;
};
export function paneWeight(
  weights: Readonly<Record<string, number>>,
  id: string,
  fallback = 1,
): number {
  const value = Object.hasOwn(weights, id) ? weights[id] : fallback;
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
export interface StageLayoutState {
  readonly focusedId: string | null;
  readonly maximizedId: string | null;
  readonly weights: Readonly<Record<string, number>>;
  readonly tree: StageTree | null;
}

/** One bounded undo checkpoint; content and content revisions are never rolled back. */
export function createStageLayoutState() {
  let state: StageLayoutState = {
    focusedId: null,
    maximizedId: null,
    weights: {},
    tree: null,
  };
  let previous: {
    state: StageLayoutState;
    panes: readonly LayoutPane[];
  } | null = null;
  return {
    snapshot: () => state,
    setTree(tree: StageTree | null) {
      state = { ...state, tree };
    },
    swapTree(a: string, b: string) {
      if (state.tree)
        state = {
          ...state,
          tree: mapTree(state.tree, (node) =>
            node.kind === 'pane'
              ? {
                  ...node,
                  instance_id:
                    node.instance_id === a
                      ? b
                      : node.instance_id === b
                        ? a
                        : node.instance_id,
                }
              : node,
          ),
        };
    },
    setWeights(weights: Readonly<Record<string, number>>) {
      state = { ...state, weights };
    },
    remember(panes: readonly LayoutPane[]) {
      previous = {
        state,
        panes: panes.map(({ instanceId, minimized }) => ({
          instanceId,
          minimized,
        })),
      };
    },
    focus(id: string) {
      state = {
        ...state,
        focusedId: id,
        maximizedId: state.maximizedId === id ? id : null,
      };
    },
    maximize(id: string) {
      state = { ...state, focusedId: id, maximizedId: id };
    },
    resize(id: string, percent: number, panes: readonly LayoutPane[]) {
      const visible = panes.filter((p) => !p.minimized);
      const rest = visible.filter((p) => p.instanceId !== id);
      if (!rest.length || !visible.some((p) => p.instanceId === id))
        return false;
      if (state.tree) {
        state = {
          ...state,
          tree: mapTree(state.tree, (node) =>
            node.kind !== 'split'
              ? node
              : node.first.kind === 'pane' && node.first.instance_id === id
                ? { ...node, percent, equal_panes: false }
                : node.second.kind === 'pane' && node.second.instance_id === id
                  ? { ...node, percent: 100 - percent, equal_panes: false }
                  : node,
          ),
        };
        return true;
      }
      const total = rest.reduce(
        (n, p) => n + paneWeight(state.weights, p.instanceId),
        0,
      );
      const weights: Record<string, number> = Object.assign(
        Object.create(null),
        state.weights,
        { [id]: percent / 100 },
      );
      for (const pane of rest)
        weights[pane.instanceId] =
          ((1 - percent / 100) * paneWeight(state.weights, pane.instanceId)) /
          total;
      state = { ...state, weights };
      return true;
    },
    restore() {
      const saved = previous;
      previous = null;
      if (saved) state = saved.state;
      return saved?.panes ?? null;
    },
    remove(id: string) {
      const weights = { ...state.weights };
      delete weights[id];
      state = {
        ...state,
        weights,
        tree: removeTreePane(state.tree, id),
        focusedId: state.focusedId === id ? null : state.focusedId,
        maximizedId: state.maximizedId === id ? null : state.maximizedId,
      };
    },
    hide(id: string) {
      state = {
        ...state,
        focusedId: state.focusedId === id ? null : state.focusedId,
        maximizedId: state.maximizedId === id ? null : state.maximizedId,
      };
    },
    reconcile(ids: readonly string[]) {
      let tree = state.tree;
      for (const id of treeIds(tree))
        if (!ids.includes(id)) tree = removeTreePane(tree, id);
      if (tree && ids.some((id) => !treeIds(tree).includes(id)))
        tree = automaticTree(ids);
      state = {
        ...state,
        tree,
        focusedId:
          state.focusedId && ids.includes(state.focusedId)
            ? state.focusedId
            : null,
        maximizedId:
          state.maximizedId && ids.includes(state.maximizedId)
            ? state.maximizedId
            : null,
        weights: Object.fromEntries(
          Object.entries(state.weights).filter(([id]) => ids.includes(id)),
        ),
      };
    },
    clear() {
      state = { focusedId: null, maximizedId: null, weights: {}, tree: null };
      previous = null;
    },
  };
}
