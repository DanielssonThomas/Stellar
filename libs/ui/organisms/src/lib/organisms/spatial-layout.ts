import type { SpatialState } from '@stellar/desktop-interaction';
import type { StageRect } from './stage-director';

export interface SpatialPlacement extends StageRect {
  readonly id: string;
  readonly depth: 'foreground' | 'middle' | 'periphery';
}

const wide = (width: number, height: number) => width >= 1000 && height >= 660;

export function spatialBand(width: number, height: number) {
  const top = wide(width, height)
    ? 74
    : Math.min(128, Math.round(height * 0.31));
  const bottom = width < 640 ? 104 : 86;
  return { top, bottom, height: Math.max(0, height - top - bottom) };
}

export function spatialEmblem(
  width: number,
  height: number,
  focus: number,
): StageRect {
  const band = spatialBand(width, height);
  const spacious = wide(width, height);
  const size = spacious
    ? Math.min(
        focus === 2 ? 160 : focus === 1 ? 205 : 238,
        width * 0.168,
        band.height * 0.34,
      )
    : Math.max(0, Math.min(74, band.top - 53, width * 0.19));
  const center = focus === 1 ? 0.81 : 0.5;
  return {
    x: Math.round(spacious ? width * center - size / 2 : width - size - 22),
    y: Math.round(
      spacious
        ? band.top + band.height * (focus === 2 ? 0.72 : 0.48) - size / 2
        : band.top - size - 8,
    ),
    width: Math.round(size),
    height: Math.round(size),
  };
}

type Slot = readonly [x: number, y: number, width: number, height: number];

const overview: readonly Slot[] = [
  [0.07, 0.22, 0.305, 0.268],
  [0.608, 0.06, 0.265, 0.22],
  [0.722, 0.43, 0.231, 0.21],
  [0.105, 0.61, 0.256, 0.21],
  [0.49, 0.755, 0.29, 0.21],
  [0.065, 0.012, 0.26, 0.175],
];
const focusSupport: readonly Slot[] = [
  [0.702, 0.025, 0.247, 0.19],
  [0.054, 0.035, 0.256, 0.165],
  [0.722, 0.738, 0.237, 0.205],
  [0.099, 0.785, 0.263, 0.183],
];
const compareSupport: readonly Slot[] = [
  [0.07, 0.594, 0.263, 0.186],
  [0.673, 0.565, 0.265, 0.186],
  [0.192, 0.802, 0.242, 0.175],
  [0.686, 0.793, 0.238, 0.175],
];

const intersects = (a: StageRect, b: StageRect, gap: number) =>
  a.x < b.x + b.width + gap &&
  b.x < a.x + a.width + gap &&
  a.y < b.y + b.height + gap &&
  b.y < a.y + a.height + gap;

export function spatialLayout(
  state: SpatialState,
  width: number,
  compact: boolean,
  height = 900,
): readonly SpatialPlacement[] {
  if (width < 32 || !state.panels.length) return [];
  const band = spatialBand(width, height);
  const featured = state.featured;
  const featuredIds = new Set(featured);
  const lead =
    state.panels.find((panel) => panel.emphasis === 'lead') ?? state.panels[0];
  const supporting = state.panels.filter((panel) => !featuredIds.has(panel.id));
  const anchor = featured.length ? undefined : lead;
  const ordered = [
    ...featured,
    ...(anchor ? [anchor.id] : []),
    ...supporting.filter((panel) => panel !== anchor).map((panel) => panel.id),
  ];
  const expanded = new Set(state.expanded);
  const placed: SpatialPlacement[] = [];
  const detailHeight = (id: string) => (expanded.has(id) ? 140 : 0);

  function place(
    id: string,
    rect: StageRect,
    depth: SpatialPlacement['depth'],
  ) {
    placed.push({
      id,
      depth,
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    });
  }

  if (wide(width, height)) {
    const emblem = spatialEmblem(width, height, featured.length);
    const reserved = { ...emblem, y: emblem.y - band.top };
    const candidates =
      featured.length === 2
        ? compareSupport
        : featured.length
          ? focusSupport
          : overview;
    const unused = [...candidates];
    const groupById = new Map(
      state.panels.map((panel) => [panel.id, panel.group]),
    );
    const groups = new Map<string, StageRect>();
    const project = ([x, y, w, h]: Slot): StageRect => ({
      x: width * x,
      y: band.height * y,
      width: width * w,
      height: Math.max(108, band.height * h * (compact ? 0.86 : 1)),
    });
    for (const [index, id] of featured.entries()) {
      const comparison = featured.length === 2;
      const slot: Slot = comparison
        ? [
            index === 0 ? 0.105 : 0.526,
            0.112,
            0.369,
            expanded.has(id) ? 0.36 : 0.255,
          ]
        : [0.145, 0.233, 0.475, expanded.has(id) ? 0.42 : 0.29];
      place(id, project(slot), 'foreground');
    }
    for (const id of ordered.slice(featured.length)) {
      const group = groupById.get(id);
      const neighbor = group ? groups.get(group) : undefined;
      const slots = unused.map((slot, index) => ({
        index,
        rect: project(slot),
      }));
      if (neighbor) {
        const distance = (rect: StageRect) =>
          Math.abs(rect.x - neighbor.x) + Math.abs(rect.y - neighbor.y);
        slots.sort((a, b) => distance(a.rect) - distance(b.rect));
      }
      const available = slots.find(
        ({ rect }) =>
          rect.y + rect.height <= band.height + 4 &&
          !intersects(rect, reserved, 12) &&
          !placed.some((item) => intersects(rect, item, 12)),
      );
      if (!available) continue;
      unused.splice(available.index, 1);
      if (group) groups.set(group, available.rect);
      place(
        id,
        available.rect,
        featured.length
          ? 'periphery'
          : id === lead.id
            ? 'foreground'
            : 'middle',
      );
    }
  }

  const inset = width < 640 ? 16 : 36;
  const gap = 16;
  const columns = width < 640 ? 1 : 2;
  const unit = (width - inset * 2 - gap * (columns - 1)) / columns;
  const baseline = placed.length ? band.height + gap : 4;
  const rowEnds = Array<number>(columns).fill(baseline);
  for (const id of ordered.filter(
    (entry) => !placed.some((item) => item.id === entry),
  )) {
    const focused = featuredIds.has(id);
    const span = focused && featured.length === 1 ? columns : 1;
    const column = rowEnds.indexOf(Math.min(...rowEnds));
    const y = span === columns ? Math.max(...rowEnds) : rowEnds[column];
    const cardHeight = (focused ? 198 : compact ? 128 : 152) + detailHeight(id);
    place(
      id,
      {
        x: inset + column * (unit + gap),
        y,
        width: span * unit + (span - 1) * gap,
        height: cardHeight,
      },
      focused || id === anchor?.id
        ? 'foreground'
        : featured.length
          ? 'periphery'
          : 'middle',
    );
    if (span === columns) rowEnds.fill(y + cardHeight + gap);
    else rowEnds[column] = y + cardHeight + gap;
  }
  return placed;
}
