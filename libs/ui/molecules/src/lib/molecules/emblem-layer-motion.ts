export interface EmblemLayerTarget {
  readonly element: HTMLElement;
  readonly transform: string;
}

export function createEmblemLayerMotion(
  view: Pick<Window, 'getComputedStyle'> | null,
  onSettled: () => void = () => undefined,
) {
  const animations = new Map<HTMLElement, Animation>();
  const transforms = new Map<HTMLElement, string>();
  let disposed = false;

  function cancel(element: HTMLElement) {
    const animation = animations.get(element);
    if (!animation) return;
    animation.onfinish = null;
    animation.oncancel = null;
    animation.cancel();
    animations.delete(element);
  }

  return {
    settled: () => animations.size === 0,
    update(targets: readonly EmblemLayerTarget[], durationMs: number) {
      if (disposed) return;
      const elements = new Set(targets.map(({ element }) => element));
      // Snapshot every interrupted pose before any cancellation or style write.
      const changes = targets.flatMap(({ element, transform }) => {
        const previous = transforms.get(element);
        if (
          previous === transform &&
          (durationMs > 0 || !animations.has(element))
        )
          return [];
        const animate = Boolean(
          previous &&
            durationMs > 0 &&
            view &&
            typeof element.animate === 'function',
        );
        return [
          {
            element,
            transform,
            animate,
            from:
              animate && view
                ? view.getComputedStyle(element).transform
                : 'none',
          },
        ];
      });
      for (const element of transforms.keys()) {
        if (!elements.has(element)) {
          cancel(element);
          transforms.delete(element);
        }
      }
      for (const { element, transform, animate, from } of changes) {
        cancel(element);
        transforms.set(element, transform);
        element.style.transform = transform;
        if (!animate) continue;
        const animation = element.animate(
          [{ transform: from }, { transform }],
          { duration: durationMs, easing: 'cubic-bezier(.2,.75,.25,1)' },
        );
        animations.set(element, animation);
        const finish = () => {
          if (animations.get(element) !== animation) return;
          animation.onfinish = null;
          animation.oncancel = null;
          animations.delete(element);
          if (!animations.size) onSettled();
        };
        animation.onfinish = finish;
        animation.oncancel = finish;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const element of animations.keys()) cancel(element);
      transforms.clear();
    },
  };
}
