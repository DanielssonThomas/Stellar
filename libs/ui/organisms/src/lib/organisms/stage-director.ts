import type { EmblemTarget } from '@stellar/desktop-interaction';

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

export interface StageLayout {
  readonly emblem: StageRect;
  readonly composer?: StageRect;
  readonly surfaces: readonly (StageRect & { readonly instanceId: string })[];
}

function tile(
  bounds: StageRect,
  items: readonly StageLayoutItem[],
): StageLayout['surfaces'] {
  if (!items.length) return [];
  if (items.length === 1)
    return [{ ...bounds, instanceId: items[0].instanceId }];
  const primary = items.findIndex((item) => item.prominence === 'primary');
  if (primary >= 0 && bounds.width >= 760) {
    const split = bounds.width * 0.54;
    const rest = items.filter((_, index) => index !== primary);
    return [
      { ...bounds, width: split, instanceId: items[primary].instanceId },
      ...rest.map((item, index) => ({
        instanceId: item.instanceId,
        x: bounds.x + split,
        y: bounds.y + (bounds.height * index) / rest.length,
        width: bounds.width - split,
        height: bounds.height / rest.length,
      })),
    ];
  }
  const count = Math.ceil(items.length / 2);
  const ratio = count / items.length;
  const horizontal = bounds.width >= bounds.height;
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
  return [
    ...tile(first, items.slice(0, count)),
    ...tile(second, items.slice(count)),
  ];
}

export function directStage(
  viewport: Readonly<{ width: number; height: number }>,
  instances: readonly StageLayoutItem[],
  target?: EmblemTarget,
  composing = false,
): StageLayout {
  const dimension = (value: number) =>
    Number.isFinite(value) ? Math.max(0, value) : 0;
  const width = dimension(viewport.width);
  const height = dimension(viewport.height);
  const padding = Math.min(24, width / 8, height / 8);
  const visible = instances
    .filter((instance) => !instance.minimized)
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
  return {
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
    surfaces: tile({ x: 0, y: 0, width, height }, visible),
  };
}
