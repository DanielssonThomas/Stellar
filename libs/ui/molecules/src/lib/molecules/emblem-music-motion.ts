import type { EmblemLayer } from './emblem-motion-model';

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
): string {
  // Ring kicks are transient animations; the underlying pose always stays exact.
  if (layer.spin) return 'none';
  const bound = (value: number) =>
    Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  const band = bound([levels.bass, levels.mid, levels.treble][index % 3]);
  const strength = band * 0.8 + bound(levels.level) * 0.2;
  if (strength === 0) return 'none';
  const detail = mode === 'calm' ? 0 : mode === 'dynamic' ? 1 : 1.7;
  const angle =
    index * 2.399963 +
    detail * (bound(levels.mid) - bound(levels.treble)) * 1.4;
  const side = layer.file.includes('violet') ? -1 : 1;
  const travel = 1.6 + detail * 1.8;
  const twist = detail * strength * Math.cos(index * 1.7) * 7;
  return `translate3d(${(Math.cos(angle) * strength * travel).toFixed(3)}%, ${(Math.sin(angle) * strength * travel).toFixed(3)}%, ${(side * strength * (2.8 + detail)).toFixed(3)}cqw) rotateX(${twist.toFixed(3)}deg) rotateY(${(-twist * 0.6).toFixed(3)}deg) rotate(${(Math.sin(angle) * strength * (2 + detail * 4)).toFixed(3)}deg)`;
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
