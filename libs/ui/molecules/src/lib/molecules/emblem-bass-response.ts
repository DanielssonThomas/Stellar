import type { EmblemLayer } from './emblem-motion-model';
import type { EmblemMusicMode } from './emblem-music-motion';

export const bassScaleReleasePerSecond = 0.16;
export interface BassSizePulse {
  readonly extra: number;
  readonly at: number;
}

export function bassSizeAt(pulse: BassSizePulse | null, time: number): number {
  return pulse
    ? Math.max(
        0,
        pulse.extra -
          (Math.max(0, time - pulse.at) / 1000) * bassScaleReleasePerSecond,
      )
    : 0;
}

export function bassSizePush(
  pulse: BassSizePulse | null,
  bass: number,
  previousBass: number,
  time: number,
  mode: EmblemMusicMode,
): BassSizePulse | null {
  if (!Number.isFinite(bass) || bass < 0.08 || bass - previousBass < 0.035)
    return null;
  const extra =
    Math.min(1, bass) *
    (mode === 'calm' ? 0.18 : mode === 'dynamic' ? 0.6 : 0.9);
  return extra > bassSizeAt(pulse, time) + 0.0001 ? { extra, at: time } : null;
}

export function closestBassRings(
  layers: readonly EmblemLayer[],
): ReadonlySet<string> {
  const groups = new Map<
    string,
    { distance: number; side: number; ids: string[] }
  >();
  for (const layer of layers) {
    const depth = layer.exploded.depth;
    if (!layer.spin || !layer.assembly || layer.assembly.count < 2 || !depth)
      continue;
    const key = layer.assembly.file;
    const group = groups.get(key) ?? {
      distance: Infinity,
      side: Math.sign(depth),
      ids: [],
    };
    group.distance = Math.min(group.distance, Math.abs(depth));
    group.ids.push(layer.id);
    groups.set(key, group);
  }
  const nearest = [-1, 1].flatMap((side) =>
    [...groups.values()]
      .filter((group) => group.side === side)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 1),
  );
  return new Set(nearest.flatMap((group) => group.ids));
}
