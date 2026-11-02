import type {
  WorkspaceSurface,
  WorkspaceToolOutcome,
  WorkspaceToolRequest,
} from '@stellar/desktop-contracts';
import type { WorkspaceToolHandler } from '@stellar/service-desktop-adapter';
import type { StageOrganism, StageResult } from '@stellar/ui-organisms';

type WorkspacePort = {
  readonly stage: Pick<StageOrganism, 'nextCommandId' | 'inspectPresentations'>;
  readonly present: (command: unknown) => StageResult;
  readonly available: () => boolean;
  readonly isCurrent: (request: WorkspaceToolRequest) => boolean;
};

const surfaces: readonly string[] = [
  'rich-text',
  'image',
  'browser',
  'diagram',
  'workflow',
  'session',
  'assistant-message',
];
const supported = (surface: string): surface is WorkspaceSurface =>
  surfaces.includes(surface);

export function desktopWorkspace(port: WorkspacePort): WorkspaceToolHandler {
  return (request): WorkspaceToolOutcome => {
    if (!port.available() || !port.isCurrent(request))
      return { kind: 'rejected' };
    const operation = request.operation;
    if (operation.kind === 'capture_window') return { kind: 'rejected' };
    if (operation.kind === 'inspect') {
      const panes = port.stage.inspectPresentations();
      if (panes.some((pane) => !supported(pane.surface)))
        return { kind: 'rejected' };
      return {
        kind: 'inspection',
        panes: panes.flatMap((pane) =>
          supported(pane.surface)
            ? [
                {
                  instance_id: pane.instanceId,
                  surface: pane.surface,
                  prominence: pane.prominence,
                  minimized: pane.minimized,
                },
              ]
            : [],
        ),
      };
    }
    const commandId = port.stage.nextCommandId();
    if (commandId === null) return { kind: 'rejected' };
    const shared = { contractVersion: 1, commandId };
    let command: unknown;
    switch (operation.kind) {
      case 'open':
      case 'update': {
        let payload: unknown;
        try {
          payload = JSON.parse(operation.payload_json);
        } catch {
          return { kind: 'rejected' };
        }
        command = {
          ...shared,
          action: operation.kind,
          instanceId: operation.instance_id,
          surface: operation.surface,
          payload,
          ...(operation.kind === 'open'
            ? { prominence: operation.prominence }
            : {}),
        };
        break;
      }
      case 'remove':
      case 'focus':
        command = {
          ...shared,
          action: operation.kind === 'remove' ? 'close' : 'focus',
          instanceId: operation.instance_id,
        };
        break;
      case 'arrange':
        command = {
          ...shared,
          action: 'arrange',
          instanceIds: operation.instance_ids,
        };
        break;
      case 'clear':
        command = { ...shared, action: 'clear' };
        break;
    }
    // No asynchronous work may separate the final owner check from mutation.
    if (!port.isCurrent(request) || !port.available())
      return { kind: 'rejected' };
    return port.present(command).status === 'applied'
      ? { kind: 'applied' }
      : { kind: 'rejected' };
  };
}
