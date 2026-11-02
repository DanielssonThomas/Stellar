import type { StageRect } from './stage-director';

type Pane = StageRect & { readonly instanceId: string };
type Target = Pane & { readonly element: HTMLElement };

export function revealOrigin(
  pane: StageRect,
  previous: readonly StageRect[],
): StageRect {
  const overlap = (other: StageRect) =>
    Math.max(
      0,
      Math.min(pane.x + pane.width, other.x + other.width) -
        Math.max(pane.x, other.x),
    ) *
    Math.max(
      0,
      Math.min(pane.y + pane.height, other.y + other.height) -
        Math.max(pane.y, other.y),
    );
  const source = [...previous].sort((a, b) => overlap(b) - overlap(a))[0];
  if (!source || overlap(source) === 0) return pane;
  if (pane.width < source.width - 1)
    return {
      ...pane,
      x: pane.x > source.x ? source.x + source.width : source.x,
      width: 0,
    };
  if (pane.height < source.height - 1)
    return {
      ...pane,
      y: pane.y > source.y ? source.y + source.height : source.y,
      height: 0,
    };
  return pane;
}

export function createStageMotion(
  view: Pick<Window, 'getComputedStyle'> | null,
) {
  const animations = new Map<HTMLElement, Animation>();
  const retiring = new Set<HTMLElement>();
  let before = new Map<string, StageRect>();
  const frame = (rect: StageRect) => ({
    left: `${rect.x}px`,
    top: `${rect.y}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  });
  const cancel = (element: HTMLElement) => {
    const animation = animations.get(element);
    if (animation) {
      animation.onfinish = null;
      animation.cancel();
      animations.delete(element);
    }
  };
  return {
    capture(elements: readonly HTMLElement[]) {
      before = new Map(
        elements.flatMap((element) => {
          const id = element.dataset['instanceId'];
          if (!id || element.classList.contains('pane-leave') || !view)
            return [];
          const style = view.getComputedStyle(element);
          return [
            [
              id,
              {
                x: parseFloat(style.left) || 0,
                y: parseFloat(style.top) || 0,
                width: parseFloat(style.width) || 0,
                height: parseFloat(style.height) || 0,
              },
            ],
          ] as const;
        }),
      );
    },
    update(targets: readonly Target[], reduced: boolean) {
      const old = before;
      before = new Map();
      if (reduced) for (const element of animations.keys()) cancel(element);
      const elements = new Set(targets.map((target) => target.element));
      for (const element of animations.keys())
        if (!elements.has(element) && !retiring.has(element)) cancel(element);
      const started: Animation[] = [];
      for (const target of targets) {
        const from =
          old.get(target.instanceId) ?? revealOrigin(target, [...old.values()]);
        cancel(target.element);
        if (
          reduced ||
          !old.size ||
          typeof target.element.animate !== 'function'
        )
          continue;
        const entering = !old.has(target.instanceId);
        if (
          !entering &&
          JSON.stringify(frame(from)) === JSON.stringify(frame(target))
        )
          continue;
        const animation = target.element.animate(
          [
            { ...frame(from), opacity: entering ? 0 : 1 },
            { ...frame(target), opacity: 1 },
          ],
          { duration: 420, easing: 'cubic-bezier(.22,.7,.25,1)' },
        );
        animations.set(target.element, animation);
        animation.onfinish = () => {
          if (animations.get(target.element) === animation)
            animations.delete(target.element);
        };
        started.push(animation);
      }
      const time = started[0]?.timeline?.currentTime;
      if (typeof time === 'number')
        for (const animation of started) animation.startTime = time;
    },
    retire(
      element: HTMLElement,
      future: readonly StageRect[],
      reduced: boolean,
      complete: () => void,
    ) {
      element.classList.add('pane-leave');
      element.setAttribute('inert', '');
      element.setAttribute('aria-hidden', 'true');
      const id = element.dataset['instanceId'];
      const from = id ? before.get(id) : undefined;
      cancel(element);
      if (reduced || !from || typeof element.animate !== 'function') {
        complete();
        return;
      }
      retiring.add(element);
      const animation = element.animate(
        [
          { ...frame(from), opacity: 1 },
          { ...frame(revealOrigin(from, future)), opacity: 0 },
        ],
        { duration: 420, easing: 'cubic-bezier(.22,.7,.25,1)' },
      );
      animations.set(element, animation);
      const finish = () => {
        animations.delete(element);
        retiring.delete(element);
        complete();
      };
      animation.onfinish = finish;
      animation.oncancel = finish;
    },
    dispose() {
      for (const element of animations.keys()) cancel(element);
      before.clear();
    },
  };
}
