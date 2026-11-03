import type { EmblemLayer } from './emblem-motion-model';
import type { EmblemMusicDirection } from './emblem-music-directions';

export interface EmblemMusicLevels {
  readonly level: number;
  readonly bass: number;
  readonly mid: number;
  readonly treble: number;
}
export type EmblemMusicMode = 'calm' | 'dynamic' | 'flashy';
export const silentEmblemMusic: EmblemMusicLevels = {
  level: 0,
  bass: 0,
  mid: 0,
  treble: 0,
};

export function musicTransform(
  layer: EmblemLayer,
  index: number,
  levels: EmblemMusicLevels,
  mode: EmblemMusicMode = 'calm',
  direction?: EmblemMusicDirection,
): string {
  // Ring kicks are transient animations; the underlying pose always stays exact.
  if (layer.spin) return 'none';
  const bound = (value: number) =>
    Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  const band = bound([levels.bass, levels.mid, levels.treble][index % 3]);
  const strength = band * 0.8 + bound(levels.level) * 0.2;
  if (strength === 0) return 'none';
  const pull = (Math.max(0, strength - 0.65) / 0.35) ** 2;
  const outward =
    direction?.outward ?? (layer.file.includes('violet') ? -1 : 1);
  const travel = mode === 'calm' ? 2.8 : mode === 'dynamic' ? 4.2 : 6;
  return `translate3d(${((direction?.inwardX ?? 0) * pull).toFixed(3)}%, ${((direction?.inwardY ?? 0) * pull).toFixed(3)}%, ${(outward * strength * travel).toFixed(3)}cqw)`;
}

export function ringKick(
  layer: EmblemLayer,
  strength: number,
  mode: EmblemMusicMode,
): string | null {
  if (!layer.spin || !layer.assembly || layer.assembly.count < 2) return null;
  const angle =
    ((layer.assembly.index + 0.5) / layer.assembly.count) * Math.PI * 2;
  const radius =
    (mode === 'calm' ? 1.5 : mode === 'dynamic' ? 5 : 9) *
    Math.max(0, Math.min(1, strength));
  return `translate(${(Math.cos(angle) * radius).toFixed(3)}%, ${(Math.sin(angle) * radius).toFixed(3)}%)`;
}
