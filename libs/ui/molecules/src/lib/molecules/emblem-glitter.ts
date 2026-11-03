import type { EmblemLayer, EmblemManifest } from './emblem-motion-model';

export function emblemLightMasks(
  layer: EmblemLayer,
  viewBox: EmblemManifest['viewBox'],
) {
  const center = layer.centroid ?? layer.anchor;
  const x = ((center.x - viewBox[0]) / viewBox[2]) * 100;
  const y = ((center.y - viewBox[1]) / viewBox[3]) * 100 - 12;
  // Complementary curved, feathered illumination over the original alpha.
  const shape = `ellipse 18% 12% at ${x}% ${y}%`;
  return [
    `radial-gradient(${shape}, white 94%, transparent 106%)`,
    `radial-gradient(${shape}, transparent 94%, white 106%)`,
  ];
}

export function nextGlitterRegions(
  count: number,
  cursor: number,
  tone: number | null,
  previousTone: number | null,
) {
  if (count <= 0) return { cursor: 0, indices: [] as number[] };
  const step =
    17 +
    (tone !== null && previousTone !== null ? (tone - previousTone) * 7 : 0);
  const next = (((cursor + step) % count) + count) % count;
  const indices = Array.from(
    { length: Math.min(count, Math.max(1, Math.ceil(count * 0.15))) },
    (_, i) => (next + i * 37) % count,
  );
  return { cursor: next, indices: [...new Set(indices)] };
}
