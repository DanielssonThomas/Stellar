export interface EmblemLayerTarget {
  readonly element: HTMLElement;
  readonly transform: string;
}

export function createEmblemLayerMotion(
  view: Pick<Window, 'getComputedStyle'> | null,
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
    update(targets: readonly EmblemLayerTarget[], durationMs: number) {
      if (disposed) return;
      const elements = new Set(targets.map(({ element }) => element));
      for (const element of transforms.keys()) {
        if (!elements.has(element)) {
          cancel(element);
          transforms.delete(element);
        }
      }
      for (const { element, transform } of targets) {
        const previous = transforms.get(element);
        if (
          previous === transform &&
          (durationMs > 0 || !animations.has(element))
        )
          continue;
        const from = view?.getComputedStyle(element).transform ?? 'none';
        cancel(element);
        transforms.set(element, transform);
        element.style.transform = transform;
        if (
          !previous ||
          durationMs <= 0 ||
          !view ||
          typeof element.animate !== 'function'
        )
          continue;
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
