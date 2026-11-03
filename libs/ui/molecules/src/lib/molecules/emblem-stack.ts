export const MAX_EMBLEM_PLANES = 64;
export const DEFAULT_PLANE_SPACING = 240;
export type EmblemSpacingProfile = 'uniform' | 'outer-dense';
export interface EmblemPlaneCore {
  readonly count: number;
  readonly spacing: number;
}

export function planeDepth(
  index: number,
  count: number,
  spacing = DEFAULT_PLANE_SPACING,
  profile: EmblemSpacingProfile = 'uniform',
  core?: EmblemPlaneCore,
): number {
  if (
    !Number.isFinite(count) ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > MAX_EMBLEM_PLANES ||
    !Number.isFinite(index) ||
    !Number.isInteger(index) ||
    index < 0 ||
    index >= count ||
    !Number.isFinite(spacing) ||
    spacing <= 0 ||
    spacing > 256 ||
    (profile !== 'uniform' && profile !== 'outer-dense') ||
    (core !== undefined &&
      (profile !== 'outer-dense' ||
        !core ||
        !Number.isInteger(core.count) ||
        core.count < 1 ||
        core.count > count ||
        (count - core.count) % 2 !== 0 ||
        !Number.isFinite(core.spacing) ||
        core.spacing <= 0 ||
        core.spacing > 256))
  ) {
    throw new RangeError('Invalid emblem plane index, count, or spacing');
  }

  const middle = (count - 1) / 2;
  const position = index - middle;
  if (profile === 'uniform' || middle === 0) return position * spacing;
  const coreRadius = ((core?.count ?? 1) - 1) / 2;
  if (core && Math.abs(position) <= coreRadius) return position * core.spacing;
  const outerRadius = middle - coreRadius;
  const normalized = (Math.abs(position) - coreRadius) / outerRadius;
  // The slope falls continuously from 1 at the center to .25 at either end.
  return (
    Math.sign(position) *
    (coreRadius * (core?.spacing ?? spacing) +
      outerRadius *
        spacing *
        (0.25 * normalized +
          (0.75 * Math.sin((normalized * Math.PI) / 2)) / (Math.PI / 2)))
  );
}
