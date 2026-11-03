import type { EmblemLayer } from './emblem-motion-model';
import {
  musicTransform,
  ringKick,
  silentEmblemMusic,
  type EmblemMusicLevels,
  type EmblemMusicMode,
} from './emblem-music-motion';

interface MusicTarget {
  readonly element: HTMLElement;
  readonly layer: EmblemLayer;
  readonly order: number;
}
type PulseProperty = 'transform' | 'opacity';

export function createEmblemMusicPulses(
  view: Pick<Window, 'getComputedStyle'> | null,
  now = () => performance.now(),
) {
  const running = new Map<
    HTMLElement,
    { animation: Animation; property: PulseProperty }
  >();
  let previous = silentEmblemMusic;
  let lastBeat = -Infinity;
  let lastMode: EmblemMusicMode | undefined;
  let disposed = false;
  const cancel = (element: HTMLElement) => {
    const entry = running.get(element);
    if (!entry) return;
    entry.animation.onfinish = null;
    entry.animation.cancel();
    running.delete(element);
  };
  const animate = (
    element: HTMLElement,
    frames: Keyframe[],
    duration: number,
    property: PulseProperty,
    delay = 0,
  ) => {
    cancel(element);
    if (!view || typeof element.animate !== 'function') return;
    const animation = element.animate(frames, {
      duration,
      delay,
      easing: 'ease-out',
    });
    running.set(element, { animation, property });
    animation.onfinish = () => {
      if (running.get(element)?.animation === animation)
        running.delete(element);
    };
  };
  const settle = (immediate: boolean) => {
    const poses = [...running].map(([element, entry]) => ({
      element,
      property: entry.property,
      from:
        !immediate && view
          ? view.getComputedStyle(element)[entry.property]
          : null,
    }));
    for (const { element, property, from } of poses) {
      cancel(element);
      if (from !== null)
        animate(
          element,
          [
            { [property]: from },
            { [property]: property === 'opacity' ? '1' : 'none' },
          ],
          160,
          property,
        );
    }
  };
  return {
    update(
      targets: readonly MusicTarget[],
      levels: EmblemMusicLevels,
      mode: EmblemMusicMode,
      active: boolean,
      paused: boolean,
    ) {
      if (disposed) return;
      const elements = new Set(targets.map((target) => target.element));
      for (const element of running.keys())
        if (!elements.has(element)) cancel(element);
      if (!active || lastMode !== mode) {
        settle(paused);
        previous = silentEmblemMusic;
        lastBeat = -Infinity;
      }
      lastMode = mode;
      const dim = active && mode === 'flashy' ? 0.62 : 1;
      for (const { element, layer, order } of targets) {
        element.style.opacity = String(dim);
        element.style.transform = musicTransform(
          layer,
          order,
          active ? levels : silentEmblemMusic,
          mode,
        );
      }
      if (!active || paused) return;
      const values = [levels.bass, levels.mid, levels.treble].map((value) =>
        Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0,
      );
      const old = [previous.bass, previous.mid, previous.treble];
      const attack = Math.max(
        ...values.map((value, index) => value - old[index]),
      );
      previous = {
        level: levels.level,
        bass: values[0],
        mid: values[1],
        treble: values[2],
      };
      const time = now();
      const cooldown = mode === 'calm' ? 750 : mode === 'dynamic' ? 480 : 360;
      if (
        attack < (mode === 'calm' ? 0.15 : 0.065) ||
        Math.max(...values) < 0.08 ||
        time - lastBeat < cooldown
      )
        return;
      lastBeat = time;
      const dominant = values.indexOf(Math.max(...values));
      for (const { element, layer, order } of targets) {
        const kick = ringKick(layer, Math.max(...values), mode);
        if (kick) {
          const from =
            running.has(element) && view
              ? view.getComputedStyle(element).transform
              : 'none';
          animate(
            element,
            [
              { transform: from, opacity: dim, offset: 0 },
              { transform: kick, opacity: 1, offset: 0.18 },
              { transform: 'none', opacity: dim, offset: 1 },
            ],
            mode === 'calm' ? 560 : 440,
            'transform',
          );
        } else if (!layer.spin && mode === 'flashy' && order % 3 === dominant) {
          animate(
            element,
            [
              { opacity: dim, offset: 0 },
              { opacity: 1, offset: 0.22 },
              { opacity: dim, offset: 1 },
            ],
            310,
            'opacity',
            (order % 5) * 18,
          );
        }
      }
    },
    dispose() {
      disposed = true;
      for (const element of running.keys()) cancel(element);
    },
  };
}
