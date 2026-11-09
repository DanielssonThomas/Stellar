import type { SpatialPlacement } from './spatial-layout';

export function createSpatialMotion() {
  let previous = new Map<string, SpatialPlacement>();
  const running = new Map<HTMLElement, Animation>();

  function cancel(element: HTMLElement) {
    running.get(element)?.cancel();
    running.delete(element);
  }

  return {
    update(
      placements: readonly SpatialPlacement[],
      elements: readonly HTMLElement[],
      reduced: boolean,
    ) {
      const current = new Map(placements.map((slot) => [slot.id, slot]));
      const active = new Set(elements);
      for (const element of running.keys())
        if (reduced || !active.has(element)) cancel(element);
      const moves = elements.flatMap((element) => {
        const id = element.dataset['panelId'] ?? '';
        const to = current.get(id);
        const from = previous.get(id);
        if (
          !from ||
          !to ||
          reduced ||
          (from.x === to.x &&
            from.y === to.y &&
            from.width === to.width &&
            from.height === to.height)
        )
          return [];
        // Read the in-flight transform before replacing it, relative to the previous layout.
        const style =
          element.ownerDocument.defaultView?.getComputedStyle(
            element,
          ).transform;
        const matrix = new DOMMatrix(
          style && style !== 'none' ? style : undefined,
        );
        return [
          {
            element,
            dx: from.x + matrix.e - to.x,
            dy: from.y + matrix.f - to.y,
            sx: (from.width * matrix.a) / to.width,
            sy: (from.height * matrix.d) / to.height,
          },
        ];
      });
      previous = current;
      for (const { element, dx, dy, sx, sy } of moves) {
        cancel(element);
        const animation = element.animate(
          [
            {
              transform: `translate3d(${dx}px, ${dy}px, 0) scale(${sx}, ${sy})`,
            },
            { transform: 'none' },
          ],
          { duration: 520, easing: 'cubic-bezier(.18,.79,.26,1.02)' },
        );
        running.set(element, animation);
        animation.onfinish = () => {
          if (running.get(element) === animation) running.delete(element);
        };
      }
    },
    dispose() {
      for (const element of running.keys()) cancel(element);
      previous.clear();
    },
  };
}
