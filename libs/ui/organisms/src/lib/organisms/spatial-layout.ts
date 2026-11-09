import type { SpatialState } from '@stellar/desktop-interaction';

export interface SpatialPlacement {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly depth: 'foreground' | 'middle' | 'periphery';
}

export function spatialLayout(
  state: SpatialState,
  width: number,
  compact: boolean,
): readonly SpatialPlacement[] {
  if (width < 32 || !state.panels.length) return [];
  const inset = width < 580 ? 14 : 32;
  const gap = width < 580 ? 14 : 22;
  const room = width - 2 * inset;
  const lead =
    state.panels.find((panel) => panel.emphasis === 'lead') ?? state.panels[0];
  const featured = state.featured;
  const supporting = state.panels.filter(
    (panel) => !featured.includes(panel.id),
  );
  const place = (
    id: string,
    x: number,
    y: number,
    w: number,
    height: number,
    depth: SpatialPlacement['depth'],
  ): SpatialPlacement => ({
    id,
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(w),
    height,
    depth,
  });
  const ordered = [...featured, ...supporting.map((panel) => panel.id)];
  const detailHeight = (id: string, base: number) =>
    state.expanded.includes(id) ? base + 168 : base;

  if (width < 640) {
    let y = 12;
    return ordered.map((id) => {
      const active = featured.includes(id);
      const height = detailHeight(id, active ? 230 : 178);
      const result = place(
        id,
        inset,
        y,
        room,
        height,
        active ? 'foreground' : 'middle',
      );
      y += height + gap;
      return result;
    });
  }

  if (featured.length) {
    const sideRails =
      !compact &&
      width >= 1060 &&
      featured.length === 1 &&
      supporting.length > 1;
    const rail = Math.min(288, room * 0.22);
    const focusRoom = sideRails ? room - 2 * (rail + gap) : room;
    const focusWidth =
      (focusRoom - gap * (featured.length - 1)) / featured.length;
    const left = sideRails ? inset + rail + gap : inset;
    const focusHeight = Math.max(
      ...featured.map((id) => detailHeight(id, 265)),
    );
    const primary = featured.map((id, i) =>
      place(
        id,
        left + i * (focusWidth + gap),
        20,
        focusWidth,
        focusHeight,
        'foreground',
      ),
    );
    const start =
      Math.max(...primary.map((slot) => slot.y + slot.height)) + gap;
    const columns = sideRails ? 2 : width >= 940 ? 3 : 2;
    const supportWidth = sideRails
      ? rail
      : (room - (columns - 1) * gap) / columns;
    return [
      ...primary,
      ...supporting.map(({ id }, i) => {
        const column = i % columns;
        const x = sideRails
          ? inset + column * (room - rail)
          : inset + column * (supportWidth + gap);
        const y = sideRails ? 46 + column * 24 : start;
        return place(
          id,
          x,
          y + Math.floor(i / columns) * (175 + gap),
          supportWidth,
          175,
          'periphery',
        );
      }),
    ];
  }

  const columns = width >= 1000 && !compact ? 3 : 2;
  const weights = columns === 3 ? [0.28, 0.42, 0.3] : [0.55, 0.45];
  const heights = columns === 3 ? [45, 12, 65] : [16, 50];
  const widths = weights.map((weight) => weight * (room - (columns - 1) * gap));
  const offsets = widths.map(
    (_, i) =>
      inset + widths.slice(0, i).reduce((sum, value) => sum + value + gap, 0),
  );
  const home = columns === 3 ? 1 : 0;
  const overview = [lead, ...supporting.filter((panel) => panel !== lead)];
  const sideOrder = columns === 3 ? [0, 2, 0, 2, 1] : [1, 0];
  const groupColumns = new Map<string, number>();
  return overview.map((panel, index) => {
    const assigned = panel.group ? groupColumns.get(panel.group) : undefined;
    const column =
      index === 0
        ? home
        : (assigned ?? sideOrder[(index - 1) % sideOrder.length]);
    if (panel.group) groupColumns.set(panel.group, column);
    const height = detailHeight(panel.id, index === 0 ? 252 : 193);
    const offset = index >= columns ? Math.min(18, widths[column] * 0.05) : 0;
    const result = place(
      panel.id,
      offsets[column] + (column === 0 ? offset : 0),
      heights[column],
      widths[column] - offset,
      height,
      index === 0 ? 'foreground' : 'middle',
    );
    heights[column] += height + gap;
    return result;
  });
}
