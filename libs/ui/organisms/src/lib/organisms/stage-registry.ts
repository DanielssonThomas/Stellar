import {
  Decoders,
  decodeStageCommand,
  StageInstance,
  StageResult,
} from './stage-contract';
import { canonicalJson, freezeJson } from './stage-json';

export function createStageRegistry<P extends object>(decoders: Decoders<P>) {
  const trusted = Object.freeze({ ...decoders });
  let instances: StageInstance<P>[] = [];
  const history = new Map<number, { command: string; result: StageResult }>();
  let highWater = 0;
  let disposed = false;

  function snapshot(): readonly StageInstance<P>[] {
    return freezeJson(
      JSON.parse(canonicalJson(instances)),
    ) as readonly StageInstance<P>[];
  }

  function interact(
    action: 'focus' | 'minimize' | 'close',
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
    if (action === 'close')
      instances = instances.filter(
        (instance) => instance.instanceId !== instanceId,
      );
    else if (action === 'minimize')
      instances[index] = { ...instances[index], minimized: true };
    else {
      const focused = { ...instances[index], minimized: false };
      instances = [
        focused,
        ...instances.filter((instance) => instance.instanceId !== instanceId),
      ];
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
        result = { status: 'applied', action: 'clear' };
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
          instances = [...instances].sort(
            (left, right) =>
              command.instanceIds.indexOf(left.instanceId) -
              command.instanceIds.indexOf(right.instanceId),
          );
          result = { status: 'applied', action: 'arrange' };
        }
      } else if (command.action === 'open') {
        const existing = instances.findIndex(
          (instance) => instance.instanceId === command.instanceId,
        );
        if (existing >= 0 || instances.length >= 4)
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
          } as StageInstance<P>);
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
        else {
          instances[existing] = {
            ...instances[existing],
            payload: command.payload,
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
    // Local keyboard controls remain available even if external sequence IDs are exhausted.
    interact,
    dispose() {
      disposed = true;
      instances = [];
      history.clear();
    },
  };
}
