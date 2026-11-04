import type { WorkspaceRenderState } from '@stellar/desktop-contracts';

export function stageRenderState(
  host: HTMLElement,
  id: string,
  hidden: boolean,
): WorkspaceRenderState {
  if (hidden) return 'hidden';
  const panel = Array.from(
    host.querySelectorAll<HTMLElement>('[data-instance-id]'),
  ).find(
    (element) =>
      element.dataset['instanceId'] === id &&
      !element.classList.contains('pane-leave'),
  );
  if (!panel || !panel.isConnected || host.ownerDocument.hidden)
    return 'unavailable';
  if (panel.inert || panel.getAttribute('aria-hidden') === 'true')
    return 'hidden';
  const state = panel.querySelector<HTMLElement>('[data-render-state]')
    ?.dataset['renderState'];
  if (state === 'error' || state === 'unavailable') return state;
  if (
    state === 'loading' ||
    panel
      .getAnimations?.({ subtree: true })
      .some(
        (animation) =>
          ['running', 'pending'].includes(animation.playState) &&
          animation.effect?.getComputedTiming().iterations !== Infinity,
      )
  )
    return 'loading';
  return panel.getBoundingClientRect().width > 0 ? 'ready' : 'unavailable';
}

/** Wait for paint, finite layout motion and media readiness; never wait indefinitely for a website. */
export async function settleStage(
  host: HTMLElement,
  observe: () => readonly { render_state: WorkspaceRenderState }[],
  current: () => boolean,
) {
  const started = performance.now();
  let stableSince = started;
  let previous = '';
  while (current() && host.isConnected && performance.now() - started < 4000) {
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    const panes = observe();
    const geometry = Array.from(
      host.querySelectorAll<HTMLElement>('[data-instance-id], .emblem-slot'),
    ).map((panel) => {
      const rect = panel.getBoundingClientRect();
      return [rect.x, rect.y, rect.width, rect.height];
    });
    const fingerprint = JSON.stringify({ panes, geometry });
    if (fingerprint !== previous) stableSince = performance.now();
    previous = fingerprint;
    if (
      !panes.some((pane) => pane.render_state === 'loading') &&
      performance.now() - stableSince >= 100
    )
      return;
  }
}
