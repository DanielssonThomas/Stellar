export const MAX_EMBLEM_PLANES = 64;
export const DEFAULT_PLANE_SPACING = 240;
export type EmblemSpacingProfile = 'uniform' | 'outer-dense';

export function planeDepth(
  index: number,
  count: number,
  spacing = DEFAULT_PLANE_SPACING,
  profile: EmblemSpacingProfile = 'uniform',
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
    (profile !== 'uniform' && profile !== 'outer-dense')
  ) {
    throw new RangeError('Invalid emblem plane index, count, or spacing');
  }

  const middle = (count - 1) / 2;
  const position = index - middle;
  if (profile === 'uniform' || middle === 0) return position * spacing;
  const normalized = position / middle;
  // The slope falls continuously from 1 at the center to .25 at either end.
  return (
    middle *
    spacing *
    (0.25 * normalized +
      (0.75 * Math.sin((normalized * Math.PI) / 2)) / (Math.PI / 2))
  );
}
