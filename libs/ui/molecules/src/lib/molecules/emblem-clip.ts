export type EmblemClip = readonly [number, number, number, number];

export function completeClipFiles(
  layers: readonly { readonly file: string; readonly clip?: EmblemClip }[],
  viewBox: readonly [number, number, number, number],
): ReadonlySet<string> {
  const complete = new Set<string>();
  const totalArea = viewBox[2] * viewBox[3];
  if (!Number.isSafeInteger(totalArea)) return complete;
  for (const file of new Set(layers.map((layer) => layer.file))) {
    const group = layers.filter((layer) => layer.file === file);
    if (
      group.length < 2 ||
      group.some(
        (layer) => !layer.clip || !validEmblemClip(layer.clip, viewBox),
      )
    )
      continue;
    const clips = group.map((layer) => layer.clip as EmblemClip);
    const area = clips.reduce((sum, clip) => sum + clip[2] * clip[3], 0);
    const overlaps = clips.some((a, index) =>
      clips
        .slice(index + 1)
        .some(
          (b) =>
            a[0] < b[0] + b[2] &&
            a[0] + a[2] > b[0] &&
            a[1] < b[1] + b[3] &&
            a[1] + a[3] > b[1],
        ),
    );
    if (area === totalArea && !overlaps) complete.add(file);
  }
  return complete;
}

export function validEmblemClip(
  value: unknown,
  viewBox: readonly [number, number, number, number],
): boolean {
  if (value === undefined) {
    return true;
  }

  if (!isValidRectangle(viewBox)) {
    return false;
  }

  if (!Array.isArray(value) || value.length !== 4) {
    return false;
  }

  const [x, y, width, height] = value;
  if (
    !isSafeInteger(x) ||
    !isSafeInteger(y) ||
    !isSafeInteger(width) ||
    !isSafeInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return false;
  }

  const [viewX, viewY, viewWidth, viewHeight] = viewBox;
  return (
    x >= viewX &&
    y >= viewY &&
    x + width <= viewX + viewWidth &&
    y + height <= viewY + viewHeight
  );
}

export function emblemClipPath(
  clip: EmblemClip | undefined,
  viewBox: readonly [number, number, number, number],
): string {
  if (clip === undefined) {
    return 'none';
  }

  if (!validEmblemClip(clip, viewBox)) {
    throw new RangeError('Invalid emblem clip or view box');
  }

  const [x, y, width, height] = clip;
  const [viewX, viewY, viewWidth, viewHeight] = viewBox;
  const top = percentage(y - viewY, viewHeight);
  const right = percentage(viewWidth - (x - viewX) - width, viewWidth);
  const bottom = percentage(viewHeight - (y - viewY) - height, viewHeight);
  const left = percentage(x - viewX, viewWidth);

  return `inset(${top}% ${right}% ${bottom}% ${left}%)`;
}

function isValidRectangle(
  rectangle: readonly [number, number, number, number],
): boolean {
  if (rectangle.length !== 4) {
    return false;
  }

  const [x, y, width, height] = rectangle;
  return (
    isSafeInteger(x) &&
    isSafeInteger(y) &&
    isSafeInteger(width) &&
    isSafeInteger(height) &&
    width > 0 &&
    height > 0
  );
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function percentage(value: number, extent: number): number {
  return (value / extent) * 100;
}
