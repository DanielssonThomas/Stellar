import type { EmblemLayer } from './emblem-motion-model';
import type { EmblemMusicDirection } from './emblem-music-directions';
import { nextGlitterRegions } from './emblem-glitter';
import {
  bassScaleReleasePerSecond,
  bassSizePush,
  closestBassRings,
  type BassSizePulse,
} from './emblem-bass-response';
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
  readonly direction?: EmblemMusicDirection;
  readonly regions?: readonly HTMLElement[];
}
type PulseProperty = 'transform' | 'filter' | 'opacity';
const glitterRest = 'brightness(0.72)';
const glitterPeak = 'brightness(3)';

export function createEmblemMusicPulses(
  view: Pick<Window, 'getComputedStyle'> | null,
  now = () => performance.now(),
) {
  const running = new Map<
    HTMLElement,
    { animation: Animation; properties: readonly PulseProperty[] }
  >();
  let previous = silentEmblemMusic;
  let lastBeat = -Infinity;
  let lastMode: EmblemMusicMode | undefined;
  let bassPulse: BassSizePulse | null = null;
  let disposed = false;
  let lightCursor = 0;
  let previousTone: number | null = null;
  let lastLight = -Infinity;

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
    properties: readonly PulseProperty[],
    delay = 0,
    easing = 'ease-out',
  ) => {
    cancel(element);
    if (!view || typeof element.animate !== 'function') return;
    const animation = element.animate(frames, { duration, delay, easing });
    running.set(element, { animation, properties });
    animation.onfinish = () => {
      if (running.get(element)?.animation === animation)
        running.delete(element);
    };
  };
  const settle = (immediate: boolean) => {
    const poses = [...running].map(([element, entry]) => {
      const style = !immediate && view ? view.getComputedStyle(element) : null;
      return {
        element,
        properties: entry.properties,
        from: style
          ? Object.fromEntries(
              entry.properties.map((property) => [property, style[property]]),
            )
          : null,
      };
    });
    for (const { element, properties, from } of poses) {
      cancel(element);
      if (from)
        animate(
          element,
          [
            from,
            Object.fromEntries(
              properties.map((property) => [
                property,
                property === 'opacity' ? '0' : 'none',
              ]),
            ),
          ],
          160,
          properties,
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
      tone: number | null = null,
    ) {
      if (disposed) return;
      const regions = targets.flatMap((target) =>
        target.layer.spin ? [] : (target.regions ?? []),
      );
      const elements = new Set(
        targets.flatMap((target) => [
          target.element,
          ...(target.regions ?? []),
        ]),
      );
      for (const element of running.keys())
        if (!elements.has(element)) cancel(element);
      if (!active || lastMode !== mode) {
        settle(paused);
        previous = silentEmblemMusic;
        lastBeat = -Infinity;
        bassPulse = null;
        previousTone = null;
        lastLight = -Infinity;
        lightCursor = 0;
      }
      lastMode = mode;
      for (const region of regions) region.style.opacity = '0';
      const baseFilter = active && mode === 'flashy' ? glitterRest : 'none';
      for (const { element, layer, order, direction } of targets) {
        element.style.opacity = '1';
        element.style.filter = baseFilter;
        element.style.transform = musicTransform(
          layer,
          order,
          active ? levels : silentEmblemMusic,
          mode,
          direction,
        );
      }
      if (!active || paused) return;
      const values = [levels.bass, levels.mid, levels.treble].map((value) =>
        Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0,
      );
      const time = now();
      const nearRings = closestBassRings(targets.map((target) => target.layer));
      const pushed = bassSizePush(
        bassPulse,
        values[0],
        previous.bass,
        time,
        mode,
      );
      if (pushed) {
        bassPulse = pushed;
        for (const { element, layer } of targets) {
          if (!nearRings.has(layer.id)) continue;
          const filterFrames = mode === 'flashy' ? { filter: glitterPeak } : {};
          animate(
            element,
            [
              {
                transform: 'scale(' + (1 + pushed.extra) + ')',
                ...filterFrames,
              },
              {
                transform: 'none',
                ...(mode === 'flashy' ? { filter: baseFilter } : {}),
              },
            ],
            (pushed.extra / bassScaleReleasePerSecond) * 1000,
            mode === 'flashy' ? ['transform', 'filter'] : ['transform'],
            0,
            'linear',
          );
        }
      }
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
      const energy = Math.max(...values);
      if (
        mode === 'flashy' &&
        energy >= 0.08 &&
        time - lastLight >= 120 &&
        (attack >= 0.065 || (tone !== null && tone !== previousTone))
      ) {
        const route = nextGlitterRegions(
          regions.length,
          lightCursor,
          tone,
          previousTone,
        );
        lightCursor = route.cursor;
        previousTone = tone;
        lastLight = time;
        for (const [index, regionIndex] of route.indices.entries()) {
          animate(
            regions[regionIndex],
            [
              { opacity: 0, offset: 0 },
              { opacity: 1, offset: 0.18 },
              { opacity: 0, offset: 1 },
            ],
            290,
            ['opacity'],
            (index % 4) * 12,
          );
        }
      }
      const cooldown = mode === 'calm' ? 750 : mode === 'dynamic' ? 480 : 360;
      if (
        attack < (mode === 'calm' ? 0.15 : 0.065) ||
        Math.max(...values) < 0.08 ||
        time - lastBeat < cooldown
      )
        return;
      lastBeat = time;
      const kicks = targets.flatMap((target) => {
        const kick = nearRings.has(target.layer.id)
          ? null
          : ringKick(target.layer, Math.max(...values), mode);
        return kick
          ? [
              {
                ...target,
                kick,
                from:
                  running.has(target.element) && view
                    ? view.getComputedStyle(target.element).transform
                    : 'none',
              },
            ]
          : [];
      });
      for (const { element, kick, from } of kicks) {
        animate(
          element,
          [
            {
              transform: from,
              ...(mode === 'flashy' ? { filter: baseFilter } : {}),
              offset: 0,
            },
            {
              transform: kick,
              ...(mode === 'flashy' ? { filter: glitterPeak } : {}),
              offset: 0.18,
            },
            {
              transform: 'none',
              ...(mode === 'flashy' ? { filter: baseFilter } : {}),
              offset: 1,
            },
          ],
          mode === 'calm' ? 560 : 440,
          mode === 'flashy' ? ['transform', 'filter'] : ['transform'],
        );
      }
    },
    dispose() {
      disposed = true;
      for (const element of running.keys()) cancel(element);
    },
  };
}
