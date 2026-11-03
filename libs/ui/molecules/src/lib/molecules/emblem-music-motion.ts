import type { EmblemLayer } from './emblem-motion-model';

export interface EmblemMusicLevels {
  readonly level: number;
  readonly bass: number;
  readonly mid: number;
  readonly treble: number;
}
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
): string {
  // Rings retain their common axis, original spacing and exact size.
  if (layer.spin) return 'none';
  const bound = (value: number) =>
    Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  const band = bound([levels.bass, levels.mid, levels.treble][index % 3]);
  const strength = band * 0.8 + bound(levels.level) * 0.2;
  if (strength === 0) return 'none';
  const angle = index * 2.399963;
  const side = layer.file.includes('violet') ? -1 : 1;
  return `translate3d(${(Math.cos(angle) * strength * 1.6).toFixed(3)}%, ${(Math.sin(angle) * strength * 1.6).toFixed(3)}%, ${(side * strength * 2.8).toFixed(3)}cqw) rotate(${(Math.sin(angle) * strength * 2).toFixed(3)}deg)`;
}
