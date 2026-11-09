import type { SpatialPlacement } from './spatial-layout';

const timing: KeyframeAnimationOptions = {
  duration: 490,
  easing: 'cubic-bezier(.21,.72,.25,1)',
};

function transformOf(element: HTMLElement) {
  const transform =
    element.ownerDocument.defaultView?.getComputedStyle(element).transform;
  return new DOMMatrix(
    transform && transform !== 'none' ? transform : undefined,
  );
}

export function createSpatialMotion() {
  let previous = new Map<string, SpatialPlacement>();
  const running = new Map<HTMLElement, readonly Animation[]>();

  function cancel(element: HTMLElement) {
    for (const animation of running.get(element) ?? []) animation.cancel();
    running.delete(element);
  }

  return {
    update(
      placements: readonly SpatialPlacement[],
      elements: readonly HTMLElement[],
      reduced: boolean,
    ) {
      const current = new Map(placements.map((slot) => [slot.id, slot]));
      for (const element of running.keys())
        if (reduced || !element.isConnected) cancel(element);
      const moves = elements.flatMap((element) => {
        const id = element.dataset['panelId'] ?? '';
        const to = current.get(id);
        const from = previous.get(id);
        if (
          !from ||
          !to ||
          reduced ||
          typeof element.animate !== 'function' ||
          typeof DOMMatrix === 'undefined' ||
          (from.x === to.x &&
            from.y === to.y &&
            from.width === to.width &&
            from.height === to.height)
        )
          return [];
        const plane = element.querySelector<HTMLElement>('.card-plane');
        const body = element.querySelector<HTMLElement>('.card-body');
        if (!plane || !body) return [];
        // Rebase from what is currently painted when another cue interrupts a move.
        const position = transformOf(element);
        const bounds = transformOf(plane);
        return [
          {
            element,
            plane,
            body,
            to,
            x: from.x + position.e - to.x,
            y: from.y + position.f - to.y,
            width: from.width * bounds.a,
            height: from.height * bounds.d,
          },
        ];
      });
      previous = current;
      const started: Animation[] = [];
      for (const { element, plane, body, to, x, y, width, height } of moves) {
        cancel(element);
        // Only the empty plane scales. Text moves at its natural aspect ratio.
        const animations = [
          element.animate(
            [
              { transform: `translate3d(${x}px, ${y}px, 0)` },
              { transform: 'none' },
            ],
            timing,
          ),
          plane.animate(
            [
              {
                transform: `scale(${width / to.width}, ${height / to.height})`,
              },
              { transform: 'none' },
            ],
            timing,
          ),
        ];
        const right = Math.max(0, to.width - width);
        const bottom = Math.max(0, to.height - height);
        if (right > 1 || bottom > 1) {
          animations.push(
            body.animate(
              [
                { clipPath: `inset(0 ${right}px ${bottom}px 0)` },
                { clipPath: 'inset(0)' },
              ],
              timing,
            ),
          );
        }
        running.set(element, animations);
        animations[0].onfinish = () => {
          if (running.get(element) === animations) running.delete(element);
        };
        started.push(...animations);
      }
      const time = started[0]?.timeline?.currentTime;
      if (typeof time === 'number')
        for (const animation of started) animation.startTime = time;
    },
    dispose() {
      for (const element of running.keys()) cancel(element);
      previous.clear();
    },
  };
}
