import { motionDurations } from '@stellar/desktop-interaction';

export interface EmblemAmbientTarget {
  readonly element: HTMLElement;
  readonly spin?: 'clockwise' | 'counter-clockwise';
  readonly order: number;
}

function rotationAngle(transform: string): number {
  const values = /^matrix\(([^)]+)\)$/
    .exec(transform)?.[1]
    .split(',')
    .map(Number);
  return values?.length === 6 && values.every(Number.isFinite)
    ? (Math.atan2(values[1], values[0]) * 180) / Math.PI
    : 0;
}

export function createEmblemAmbientMotion(
  view: Pick<Window, 'getComputedStyle'> | null,
) {
  const running = new Map<
    HTMLElement,
    { animation: Animation; idle: boolean }
  >();
  let disposed = false;
  const cancel = (element: HTMLElement) => {
    const entry = running.get(element);
    if (!entry) return;
    entry.animation.onfinish = null;
    entry.animation.oncancel = null;
    entry.animation.cancel();
    running.delete(element);
  };
  return {
    update(
      targets: readonly EmblemAmbientTarget[],
      idle: boolean,
      paused: boolean,
    ) {
      if (disposed) return;
      const elements = new Set(targets.map(({ element }) => element));
      for (const element of running.keys())
        if (!elements.has(element)) cancel(element);
      for (const { element, spin, order } of targets) {
        if (running.get(element)?.idle === idle && !paused) continue;
        const from = view?.getComputedStyle(element).transform ?? 'none';
        cancel(element);
        element.style.transform = 'none';
        if (paused || !view || typeof element.animate !== 'function') continue;
        if (!idle && from === 'none') continue;
        const direction = spin === 'counter-clockwise' ? -1 : 1;
        const ordinal = Number.isFinite(order)
          ? Math.max(0, Math.min(31, order))
          : 0;
        const angle = rotationAngle(from);
        const frames = spin
          ? [`rotateZ(${angle}deg)`, `rotateZ(${angle + 360 * direction}deg)`]
          : [from, 'translateY(-1.1%)', 'translateY(1.1%)', from];
        const animation = element.animate(
          (idle ? frames : [from, 'none']).map((transform) => ({ transform })),
          {
            duration: idle
              ? (spin ? 16000 : 6000) + ordinal * 170
              : motionDurations.focus,
            iterations: idle ? Infinity : 1,
            easing: idle && spin ? 'linear' : 'ease-in-out',
          },
        );
        running.set(element, { animation, idle });
        animation.onfinish = () => {
          if (running.get(element)?.animation !== animation) return;
          animation.onfinish = null;
          running.delete(element);
        };
      }
    },
    dispose() {
      disposed = true;
      for (const element of running.keys()) cancel(element);
    },
  };
}
