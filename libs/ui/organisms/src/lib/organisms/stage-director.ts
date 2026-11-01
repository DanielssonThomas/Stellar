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
  readonly surfaces: readonly (StageRect & { readonly instanceId: string })[];
}

export function directStage(
  viewport: Readonly<{ width: number; height: number }>,
  instances: readonly StageLayoutItem[],
  target?: EmblemTarget,
): StageLayout {
  const dimension = (value: number) =>
    Number.isFinite(value) ? Math.max(0, value) : 0;
  const width = dimension(viewport.width);
  const height = dimension(viewport.height);
  const padding = Math.min(24, width / 8, height / 8);
  const visible = instances
    .filter((instance) => !instance.minimized)
    .slice(0, 4);
  const docked = target ? target === 'docked' : visible.length > 0;
  const size = docked
    ? Math.min(96, width - padding * 2, height * 0.2)
    : Math.min(
        target === 'focused' ? 320 : target === 'center' ? 480 : 280,
        width - padding * 2,
        height - padding * 2,
      );
  const emblem = {
    x: docked ? Math.max(padding, width - padding - size) : (width - size) / 2,
    y: docked ? height - padding - size : (height - size) / 2,
    width: size,
    height: size,
  };
  if (!visible.length) return { emblem, surfaces: [] };
  const columns = width >= 760 && visible.length > 1 ? 2 : 1;
  const rows = Math.ceil(visible.length / columns);
  const availableWidth = width - padding * 2;
  const availableHeight = Math.max(0, emblem.y - padding * 2);
  const gap = Math.min(
    16,
    availableWidth / (columns * 2),
    availableHeight / (rows * 2),
  );
  const cellWidth = Math.max(
    0,
    (availableWidth - gap * (columns - 1)) / columns,
  );
  const cellHeight = Math.max(0, (availableHeight - gap * (rows - 1)) / rows);
  const surfaces = visible.map((instance, index) => {
    const itemWidth = Math.min(
      instance.prominence === 'primary' ? 440 : 340,
      cellWidth,
    );
    const itemHeight = Math.min(240, cellHeight);
    return {
      instanceId: instance.instanceId,
      x:
        padding +
        (index % columns) * (cellWidth + gap) +
        (cellWidth - itemWidth) / 2,
      y:
        padding +
        Math.floor(index / columns) * (cellHeight + gap) +
        (cellHeight - itemHeight) / 2,
      width: itemWidth,
      height: itemHeight,
    };
  });
  return { emblem, surfaces };
}
