import type { EmblemTarget } from '@stellar/desktop-interaction';
import { paneWeight } from './stage-layout-state';

export interface StageRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface StageLayoutItem {
  readonly instanceId: string;
  readonly prominence: 'primary' | 'secondary';
  readonly minimized: boolean;
}

export interface StageDivider extends StageRect {
  readonly id: string;
  readonly axis: 'x' | 'y';
  readonly first: readonly string[];
  readonly second: readonly string[];
  readonly bounds: StageRect;
  readonly ratio: number;
  readonly minimum: number;
}
export interface StageLayout {
  readonly dividers: readonly StageDivider[];
  readonly emblem: StageRect;
  readonly composer?: StageRect;
  readonly surfaces: readonly (StageRect & { readonly instanceId: string })[];
}

function tile(
  bounds: StageRect,
  items: readonly StageLayoutItem[],
  weights: Readonly<Record<string, number>>,
  dividers: StageDivider[],
  root = true,
): StageLayout['surfaces'] {
  if (!items.length) return [];
  if (items.length === 1)
    return [{ ...bounds, instanceId: items[0].instanceId }];
  const primary =
    root &&
    items.some((item) => item.prominence === 'primary') &&
    bounds.width >= 760;
  const count = primary ? 1 : Math.ceil(items.length / 2);
  const horizontal = primary || bounds.width >= bounds.height;
  const firstItems = items.slice(0, count),
    secondItems = items.slice(count);
  const sum = (group: readonly StageLayoutItem[]) =>
    group.reduce(
      (n, p) =>
        n +
        paneWeight(
          weights,
          p.instanceId,
          primary ? (p === items[0] ? 0.54 : 0.46 / secondItems.length) : 1,
        ),
      0,
    );
  const dimension = horizontal ? bounds.width : bounds.height;
  const minimum = Math.min(
    0.5,
    (horizontal ? 220 : 140) / Math.max(1, dimension),
  );
  const ratio = Math.max(
    minimum,
    Math.min(
      1 - minimum,
      sum(firstItems) / (sum(firstItems) + sum(secondItems)),
    ),
  );
  const first = horizontal
    ? { ...bounds, width: bounds.width * ratio }
    : { ...bounds, height: bounds.height * ratio };
  const second = horizontal
    ? {
        ...bounds,
        x: bounds.x + first.width,
        width: bounds.width - first.width,
      }
    : {
        ...bounds,
        y: bounds.y + first.height,
        height: bounds.height - first.height,
      };
  const firstIds = firstItems.map((p) => p.instanceId),
    secondIds = secondItems.map((p) => p.instanceId);
  dividers.push({
    id: [...firstIds, 'split', ...secondIds].join(':'),
    axis: horizontal ? 'x' : 'y',
    first: firstIds,
    second: secondIds,
    bounds,
    ratio,
    minimum,
    x: horizontal ? second.x - 4 : bounds.x,
    y: horizontal ? bounds.y : second.y - 4,
    width: horizontal ? 8 : bounds.width,
    height: horizontal ? bounds.height : 8,
  });
  return [
    ...tile(first, firstItems, weights, dividers, false),
    ...tile(second, secondItems, weights, dividers, false),
  ];
}

export function directStage(
  viewport: Readonly<{ width: number; height: number }>,
  instances: readonly StageLayoutItem[],
  target?: EmblemTarget,
  composing = false,
  layout?: {
    readonly maximizedId: string | null;
    readonly weights: Readonly<Record<string, number>>;
  },
): StageLayout {
  const dimension = (value: number) =>
    Number.isFinite(value) ? Math.max(0, value) : 0;
  const width = dimension(viewport.width);
  const height = dimension(viewport.height);
  const padding = Math.min(24, width / 8, height / 8);
  const visible = instances
    .filter(
      (instance) =>
        !instance.minimized &&
        (!layout?.maximizedId || layout.maximizedId === instance.instanceId),
    )
    .slice(0, 4);
  const docked = !composing && (visible.length > 0 || target === 'docked');
  const composerHeight = Math.min(
    240,
    Math.max(80, height * 0.25),
    height * 0.4,
  );
  const composerGap = Math.min(20, height * 0.035);
  const size = composing
    ? Math.max(
        0,
        Math.min(
          480,
          width - padding * 2,
          height - padding * 2 - composerHeight - composerGap,
        ),
      )
    : docked
      ? Math.min(
          144,
          Math.max(64, width * 0.09),
          width - padding * 2,
          height * 0.18,
        )
      : Math.min(
          target === 'focused' ? 320 : target === 'center' ? 480 : 280,
          width - padding * 2,
          height - padding * 2,
        );
  const emblem = {
    x: docked ? Math.max(padding, width - padding - size) : (width - size) / 2,
    y: composing
      ? (height - size - composerHeight - composerGap) / 2
      : docked
        ? height - padding - size
        : (height - size) / 2,
    width: size,
    height: size,
  };
  const composerWidth = Math.min(800, width - padding * 2);
  const dividers: StageDivider[] = [];
  const surfaces = tile(
    { x: 0, y: 0, width, height },
    visible,
    layout?.weights ?? {},
    dividers,
  );
  return {
    dividers,
    emblem,
    ...(composing
      ? {
          composer: {
            x: (width - composerWidth) / 2,
            y: emblem.y + size + composerGap,
            width: composerWidth,
            height: composerHeight,
          },
        }
      : {}),
    surfaces,
  };
}
