import type { LocalAction } from '@stellar/service-desktop-adapter';
import type { StageOrganism } from '@stellar/ui-organisms';

type Port = {
  stage: Pick<StageOrganism, 'inspectPresentations' | 'nextCommandId'>;
  present: (command: unknown) => { status: string };
  available: () => boolean;
};

/** Compose existing validated Stage operations into request-scoped local capabilities. */
export function desktopReflex(port: Port) {
  return () => {
    const panes = port.stage.inspectPresentations();
    const fingerprint = JSON.stringify(panes);
    const valid = () =>
      port.available() &&
      JSON.stringify(port.stage.inspectPresentations()) === fingerprint;
    const actions: LocalAction[] = [];
    const add = (
      id: string,
      description: string,
      command: Record<string, unknown>,
    ) => {
      actions.push({
        id,
        description,
        valid,
        execute: () => {
          if (!valid()) return 'rejected';
          const commandId = port.stage.nextCommandId();
          if (commandId === null) return 'rejected';
          return port.present({ contractVersion: 1, commandId, ...command })
            .status === 'applied'
            ? 'confirmed'
            : 'rejected';
        },
      });
    };
    for (const pane of panes.slice(0, 8)) {
      const id = pane.instanceId;
      for (const action of [
        'focus',
        'close',
        'minimize',
        'restore',
        'maximize',
      ] as const)
        add(
          `pane.${pane.position}.${action}`,
          `${action} pane ${pane.position}: ${[...pane.title].slice(0, 40).join('')}`,
          { action, instanceId: id },
        );
      if (panes.filter((p) => !p.minimized).length > 1)
        for (const percent of [25, 50, 75])
          add(
            `pane.${pane.position}.resize${percent}`,
            `Resize pane ${pane.position} to ${percent}% of layout`,
            { action: 'resize', instanceId: id, percent },
          );
      for (const direction of ['left', 'right'] as const) {
        const other = panes[pane.position + (direction === 'left' ? -1 : 1)];
        if (other)
          add(
            `pane.${pane.position}.${direction}`,
            `Move pane ${pane.position} one position ${direction}`,
            { action: 'swap', instanceId: id, otherId: other.instanceId },
          );
      }
    }
    add('layout.restore', 'Restore previous presentation layout', {
      action: 'restore-layout',
    });
    for (const kind of ['session', 'workflow'] as const)
      add(
        `view.${kind}`,
        `Open a new ${kind} presentation; focus selects an existing pane`,
        {
          action: 'open',
          surface: kind,
          instanceId: `reflex-${kind}`,
          prominence: 'primary',
          payload: {
            kind,
            title: kind === 'session' ? 'Ivy session' : 'Stellar workflow',
          },
        },
      );
    return {
      context: JSON.stringify(
        panes.slice(0, 8).map((p) => ({
          pane: p.position,
          title: [...p.title].slice(0, 40).join(''),
          selected: p.selected,
          surface: p.surface,
          minimized: p.minimized,
          maximized: p.maximized,
        })),
      ),
      actions,
    };
  };
}
