import { expect, it, vi } from 'vitest';
import type { StageOrganism } from '@stellar/ui-organisms';
import { desktopReflex } from './desktop-reflex';

it('keeps pane capabilities valid across rendering transitions while fencing content and layout edits', () => {
  let panes: ReturnType<StageOrganism['inspectPresentations']> = [
    {
      instanceId: 'image',
      surface: 'image',
      prominence: 'primary',
      minimized: false,
      revision: 1,
      title: 'Reference',
      selected: true,
      maximized: false,
      position: 0,
      rect: { instanceId: 'image', x: 0, y: 0, width: 600, height: 400 },
      viewport: { width: 1200, height: 800 },
      render_state: 'loading',
    },
  ];
  const present = vi.fn(() => ({ status: 'applied' }));
  const capture = desktopReflex({
    stage: { inspectPresentations: () => panes, nextCommandId: () => 1 },
    present,
    available: () => true,
  });
  const { actions } = capture();
  const close = actions.find((action) => action.id === 'pane.0.close');
  if (!close) throw Error('Missing close capability');
  panes = panes.map((pane) => ({ ...pane, render_state: 'ready' }));
  expect(close.valid()).toBe(true);
  panes = panes.map((pane) => ({ ...pane, render_state: 'error' }));
  expect(close.execute('one')).toBe('confirmed');
  expect(present).toHaveBeenCalledOnce();
  panes = panes.map((pane) => ({ ...pane, revision: 2 }));
  expect(close.valid()).toBe(false);
  expect(close.execute('two')).toBe('rejected');
  const current = capture().actions.find(
    (action) => action.id === 'pane.0.close',
  );
  if (!current) throw Error('Missing renewed close capability');
  panes = panes.map((pane) => ({
    ...pane,
    rect: {
      ...pane.rect,
      instanceId: 'image',
      x: 600,
      y: 0,
      width: 600,
      height: 400,
    },
  }));
  expect(current.valid()).toBe(false);
  expect(present).toHaveBeenCalledOnce();
});
