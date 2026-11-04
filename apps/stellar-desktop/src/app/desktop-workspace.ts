import type {
  WorkspaceSurface,
  WorkspaceToolOutcome,
  WorkspaceToolRequest,
} from '@stellar/desktop-contracts';
import type { WorkspaceToolHandler } from '@stellar/service-desktop-adapter';
import type { StageOrganism, StageResult } from '@stellar/ui-organisms';

type WorkspacePort = {
  readonly stage: Pick<
    StageOrganism,
    'nextCommandId' | 'inspectPresentations'
  > &
    Partial<Pick<StageOrganism, 'inspectContent'>>;
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
  'activity-summary',
];
const supported = (surface: string): surface is WorkspaceSurface =>
  surfaces.includes(surface);

export function desktopWorkspace(port: WorkspacePort): WorkspaceToolHandler {
  return (request): WorkspaceToolOutcome => {
    if (!port.available() || !port.isCurrent(request))
      return { kind: 'rejected' };
    const operation = request.operation;
    if (
      [
        'capture_window',
        'capture_display',
        'capture_foreground',
        'list_displays',
      ].includes(operation.kind)
    )
      return { kind: 'rejected' };
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
                  operations: [
                    'focus',
                    'minimize',
                    'restore',
                    'close',
                    'arrange',
                    'swap',
                    'resize',
                    'maximize',
                    'restore_layout',
                    ...(pane.surface === 'activity-summary'
                      ? []
                      : (['update', 'inspect_content'] as const)),
                    ...(pane.surface === 'image' ? (['gallery'] as const) : []),
                    ...(pane.surface === 'browser'
                      ? (['browser_navigation'] as const)
                      : []),
                    ...(pane.surface === 'workflow'
                      ? (['focus_agent'] as const)
                      : []),
                  ],
                  ...('revision' in pane
                    ? {
                        layout: {
                          title: pane.title,
                          revision: pane.revision,
                          selected: pane.selected,
                          maximized: pane.maximized,
                          position: pane.position,
                          x: Math.round(
                            (1000 * (pane.rect?.x ?? 0)) /
                              Math.max(1, pane.viewport.width),
                          ),
                          y: Math.round(
                            (1000 * (pane.rect?.y ?? 0)) /
                              Math.max(1, pane.viewport.height),
                          ),
                          width: Math.round(
                            (1000 * (pane.rect?.width ?? 0)) /
                              Math.max(1, pane.viewport.width),
                          ),
                          height: Math.round(
                            (1000 * (pane.rect?.height ?? 0)) /
                              Math.max(1, pane.viewport.height),
                          ),
                        },
                      }
                    : {}),
                },
              ]
            : [],
        ),
      };
    }
    if (operation.kind === 'inspect_content') {
      const content = port.stage.inspectContent?.(operation.instance_id);
      if (!content || !supported(content.surface)) return { kind: 'rejected' };
      return {
        kind: 'content',
        instance_id: content.instanceId,
        surface: content.surface,
        revision: content.revision,
        payload_json: content.payload,
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
          ...(operation.kind === 'update' && operation.expected_revision != null
            ? { expectedRevision: operation.expected_revision }
            : {}),
          ...(operation.kind === 'open'
            ? { prominence: operation.prominence }
            : {}),
        };
        break;
      }
      case 'remove':
      case 'focus':
      case 'minimize':
      case 'restore':
      case 'maximize':
        command = {
          ...shared,
          action: operation.kind === 'remove' ? 'close' : operation.kind,
          instanceId: operation.instance_id,
        };
        break;
      case 'resize':
        command = {
          ...shared,
          action: 'resize',
          instanceId: operation.instance_id,
          percent: operation.percent,
        };
        break;
      case 'swap':
        command = {
          ...shared,
          action: 'swap',
          instanceId: operation.instance_id,
          otherId: operation.other_id,
        };
        break;
      case 'restore_layout':
        command = { ...shared, action: 'restore-layout' };
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
