import {
  automaticTree,
  treeIds,
  splitTree,
  resizeTree,
  MAX_STAGE_PANES,
} from './stage-tree';
import {
  Decoders,
  decodeStageCommand,
  StageInstance,
  StageResult,
} from './stage-contract';
import { canonicalJson } from './stage-json';
import { createStageLayoutState, paneWeight } from './stage-layout-state';

export function createStageRegistry<P extends object>(decoders: Decoders<P>) {
  const trusted = Object.freeze({ ...decoders });
  let instances: StageInstance<P>[] = [];
  const history = new Map<number, { command: string; result: StageResult }>();
  let highWater = 0;
  let disposed = false;
  const layout = createStageLayoutState();

  function snapshot(): readonly StageInstance<P>[] {
    return Object.freeze(
      instances.map((instance) => Object.freeze({ ...instance })),
    ) as readonly StageInstance<P>[];
  }

  function interact(
    action: 'focus' | 'minimize' | 'restore' | 'maximize' | 'close',
    instanceId: string,
  ): StageResult {
    if (disposed) return { status: 'rejected', reason: 'disposed' };
    const index = instances.findIndex(
      (instance) => instance.instanceId === instanceId,
    );
    if (index < 0)
      return action === 'close'
        ? { status: 'applied', action }
        : { status: 'rejected', reason: 'missing-instance' };
    if (action === 'maximize') {
      if (instances[index].minimized)
        return { status: 'rejected', reason: 'minimized-instance' };
      if (layout.snapshot().maximizedId !== instanceId)
        layout.remember(instances);
      layout.maximize(instanceId);
    } else if (action === 'close') {
      instances = instances.filter(
        (instance) => instance.instanceId !== instanceId,
      );
      layout.remove(instanceId);
    } else if (action === 'minimize') {
      layout.remember(instances);
      instances[index] = { ...instances[index], minimized: true };
      layout.hide(instanceId);
    } else {
      instances[index] = { ...instances[index], minimized: false };
      layout.focus(instanceId);
    }
    return { status: 'applied', action, instanceId };
  }

  return {
    nextCommandId(): number | null {
      return disposed || highWater === Number.MAX_SAFE_INTEGER
        ? null
        : highWater + 1;
    },
    dispatch(input: unknown): StageResult {
      if (disposed) return { status: 'rejected', reason: 'disposed' };
      const command = decodeStageCommand(input, trusted);
      if (!command) return { status: 'rejected', reason: 'invalid-command' };
      const canonical = canonicalJson(command);
      const previous = history.get(command.commandId);
      if (previous)
        return previous.command === canonical
          ? { ...previous.result, status: 'duplicate' }
          : { status: 'rejected', reason: 'command-id-conflict' };
      if (command.commandId <= highWater)
        return { status: 'rejected', reason: 'stale-command' };
      highWater = command.commandId;
      let result: StageResult;
      if (command.action === 'clear') {
        instances = [];
        layout.clear();
        result = { status: 'applied', action: 'clear' };
      } else if (command.action === 'restore-layout') {
        const saved = layout.restore();
        if (!saved)
          result = { status: 'rejected', reason: 'no-previous-layout' };
        else {
          const order = saved.map((p) => p.instanceId);
          instances = instances
            .map((p) => ({
              ...p,
              minimized:
                saved.find((s) => s.instanceId === p.instanceId)?.minimized ??
                p.minimized,
            }))
            .sort(
              (a, b) =>
                order.indexOf(a.instanceId) - order.indexOf(b.instanceId),
            );
          layout.reconcile(instances.map((p) => p.instanceId));
          result = { status: 'applied', action: command.action };
        }
      } else if (
        command.action === 'set-layout' ||
        command.action === 'split-pane' ||
        command.action === 'resize-split'
      ) {
        const current =
          layout.snapshot().tree ??
          automaticTree(instances.map((p) => p.instanceId));
        const next =
          command.action === 'set-layout'
            ? command.tree
            : !current
              ? null
              : command.action === 'split-pane'
                ? splitTree(
                    current,
                    command.instanceId,
                    command.otherId,
                    command.splitId,
                    command.placement,
                  )
                : resizeTree(current, command.splitId, command.percent);
        const ids = treeIds(next);
        if (
          !next ||
          ids.length !== instances.length ||
          instances.some((p) => !ids.includes(p.instanceId)) ||
          layout.snapshot().maximizedId
        )
          result = { status: 'rejected', reason: 'invalid-layout' };
        else {
          layout.remember(instances);
          layout.setTree(next);
          instances.sort(
            (a, b) => ids.indexOf(a.instanceId) - ids.indexOf(b.instanceId),
          );
          result = { status: 'applied', action: command.action };
        }
      } else if (command.action === 'resize') {
        const panes = instances.filter((p) => !p.minimized);
        if (
          panes.length < 2 ||
          !panes.some((p) => p.instanceId === command.instanceId) ||
          layout.snapshot().maximizedId
        )
          result = { status: 'rejected', reason: 'not-resizable' };
        else {
          layout.remember(instances);
          if (!layout.snapshot().tree && instances.length > 4)
            layout.setTree(automaticTree(instances.map((p) => p.instanceId)));
          layout.resize(command.instanceId, command.percent, instances);
          result = {
            status: 'applied',
            action: command.action,
            instanceId: command.instanceId,
          };
        }
      } else if (command.action === 'swap') {
        const a = instances.findIndex(
          (p) => p.instanceId === command.instanceId,
        );
        const b = instances.findIndex((p) => p.instanceId === command.otherId);
        if (a < 0 || b < 0)
          result = { status: 'rejected', reason: 'missing-instance' };
        else {
          layout.remember(instances);
          [instances[a], instances[b]] = [instances[b], instances[a]];
          layout.swapTree(command.instanceId, command.otherId);
          result = { status: 'applied', action: command.action };
        }
      } else if (command.action === 'arrange') {
        const byId = new Map(
          instances.map((instance) => [instance.instanceId, instance]),
        );
        if (
          command.instanceIds.length !== instances.length ||
          command.instanceIds.some((id) => !byId.has(id))
        )
          result = { status: 'rejected', reason: 'instance-set-mismatch' };
        else {
          layout.remember(instances);
          instances = [...instances].sort(
            (left, right) =>
              command.instanceIds.indexOf(left.instanceId) -
              command.instanceIds.indexOf(right.instanceId),
          );
          layout.setTree(null);
          result = { status: 'applied', action: 'arrange' };
        }
      } else if (command.action === 'open') {
        const existing = instances.findIndex(
          (instance) => instance.instanceId === command.instanceId,
        );
        if (existing >= 0 || instances.length >= MAX_STAGE_PANES)
          result = {
            status: 'rejected',
            reason: existing >= 0 ? 'instance-exists' : 'instance-limit',
          };
        else {
          instances.push({
            instanceId: command.instanceId,
            surface: command.surface,
            payload: command.payload,
            prominence: command.prominence,
            minimized: false,
            revision: 0,
            userEdited: false,
          } as StageInstance<P>);
          const tree = layout.snapshot().tree;
          if (tree) {
            let splitId = 'auto_new';
            while (JSON.stringify(tree).includes('"' + splitId + '"'))
              splitId += '_';
            layout.setTree({
              kind: 'split',
              split_id: splitId,
              axis: 'vertical',
              percent: 50,
              first: tree,
              second: { kind: 'pane', instance_id: command.instanceId },
            });
          }
          layout.focus(command.instanceId);
          result = {
            status: 'applied',
            action: command.action,
            instanceId: command.instanceId,
          };
        }
      } else if (command.action === 'update') {
        const existing = instances.findIndex(
          (instance) => instance.instanceId === command.instanceId,
        );
        if (existing < 0 || instances[existing].surface !== command.surface)
          result = { status: 'rejected', reason: 'surface-mismatch' };
        else if (
          (command.expectedRevision !== undefined &&
            command.expectedRevision !== instances[existing].revision) ||
          (instances[existing].userEdited &&
            command.expectedRevision === undefined)
        )
          result = { status: 'rejected', reason: 'revision-conflict' };
        else {
          instances[existing] = {
            ...instances[existing],
            payload: command.payload,
            revision: instances[existing].revision + 1,
          } as StageInstance<P>;
          result = {
            status: 'applied',
            action: command.action,
            instanceId: command.instanceId,
          };
        }
      } else result = interact(command.action, command.instanceId);
      history.set(command.commandId, {
        command: canonical,
        result: Object.freeze({ ...result }),
      });
      if (history.size > 64)
        history.delete(history.keys().next().value as number);
      return result;
    },
    snapshot,
    inspect: snapshot,
    layout: layout.snapshot,
    edit(instanceId: string, payload: unknown): StageResult {
      const current = instances.find((p) => p.instanceId === instanceId);
      const decoded = current
        ? decodeStageCommand(
            {
              contractVersion: 1,
              commandId: 1,
              action: 'update',
              instanceId,
              surface: current.surface,
              payload,
            },
            trusted,
          )
        : null;
      if (!current || !decoded || decoded.action !== 'update')
        return { status: 'rejected', reason: 'invalid-content' };
      instances = instances.map((p) =>
        p.instanceId === instanceId
          ? ({
              ...p,
              payload: decoded.payload,
              revision: p.revision + 1,
              userEdited: true,
            } as StageInstance<P>)
          : p,
      );
      return { status: 'applied', action: 'update', instanceId };
    },
    resizeGroup(
      first: readonly string[],
      second: readonly string[],
      ratio: number,
      requestedSplitId?: string,
    ) {
      if (!Number.isFinite(ratio) || ratio < 0.1 || ratio > 0.9) return;
      if (!layout.snapshot().tree && instances.length > 4)
        layout.setTree(automaticTree(instances.map((p) => p.instanceId)));
      const tree = layout.snapshot().tree;
      if (tree) {
        let splitId: string | null = requestedSplitId ?? null;
        const seek = (node: typeof tree): void => {
          if (node.kind !== 'split') return;
          if (
            JSON.stringify(treeIds(node.first)) === JSON.stringify(first) &&
            JSON.stringify(treeIds(node.second)) === JSON.stringify(second)
          )
            splitId = node.split_id;
          seek(node.first);
          seek(node.second);
        };
        if (!splitId) seek(tree);
        if (splitId) {
          const next = resizeTree(
            tree,
            splitId,
            Math.max(10, Math.min(90, Math.round(ratio * 100))),
          );
          if (next) layout.setTree(next);
        }
        return;
      }
      const weights = layout.snapshot().weights;
      const all = [...first, ...second];
      const total = all.reduce((n, id) => n + paneWeight(weights, id), 0);
      const next: Record<string, number> = Object.assign(
        Object.create(null),
        weights,
      );
      for (const [ids, share] of [
        [first, ratio],
        [second, 1 - ratio],
      ] as const) {
        const sum = ids.reduce((n, id) => n + paneWeight(weights, id), 0);
        for (const id of ids)
          next[id] = (total * share * paneWeight(weights, id)) / sum;
      }
      layout.setWeights(next);
    },
    rememberLayout: () => layout.remember(instances),
    setLayoutWeights: layout.setWeights,
    // Local keyboard controls remain available even if external sequence IDs are exhausted.
    interact,
    dispose() {
      disposed = true;
      instances = [];
      layout.clear();
      history.clear();
    },
  };
}
