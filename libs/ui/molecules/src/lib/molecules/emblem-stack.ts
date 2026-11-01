export const MAX_EMBLEM_PLANES = 32;
export const DEFAULT_PLANE_SPACING = 240;

export function planeDepth(
  index: number,
  count: number,
  spacing = DEFAULT_PLANE_SPACING,
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
    spacing > 256
  ) {
    throw new RangeError('Invalid emblem plane index, count, or spacing');
  }

  return (index - (count - 1) / 2) * spacing;
}
