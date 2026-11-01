import type { Phase } from '@stellar/desktop-interaction';

export interface EmblemPose {
  readonly x: number;
  readonly y: number;
  readonly rotation: number;
}

export interface EmblemLayer {
  readonly id: string;
  readonly file: string;
  readonly z: number;
  readonly anchor: { readonly x: number; readonly y: number };
  readonly assembled: EmblemPose;
  readonly exploded: EmblemPose;
  readonly spin?: 'clockwise' | 'counter-clockwise';
}

export interface EmblemManifest {
  readonly version: 1;
  readonly viewBox: readonly [number, number, number, number];
  readonly layers: readonly EmblemLayer[];
}

export function clampAudioLevel(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

export function isExplodedPhase(phase: Phase): boolean {
  return phase === 'focusing' || phase === 'listening' || phase === 'hangover';
}

export function layerTransform(
  layer: EmblemLayer,
  manifest: EmblemManifest,
  phase: Phase,
  reducedMotion: boolean,
): string {
  const pose = isExplodedPhase(phase) ? layer.exploded : layer.assembled;
  const layers = Array.isArray(manifest?.layers) ? manifest.layers : [];
  const zs = layers.map((item) => item?.z).filter(Number.isFinite);
  const minZ = zs.length ? Math.min(...zs) : layer.z;
  const maxZ = zs.length ? Math.max(...zs) : layer.z;
  const depth =
    reducedMotion || !isExplodedPhase(phase) || maxZ === minZ
      ? 0
      : ((layer.z - (minZ + maxZ) / 2) / (maxZ - minZ)) * 18;
  const width = manifest?.viewBox?.[2];
  const height = manifest?.viewBox?.[3];
  const x = Number.isFinite(width) && width !== 0 ? (pose.x / width) * 100 : 0;
  const y =
    Number.isFinite(height) && height !== 0 ? (pose.y / height) * 100 : 0;
  return `translate(${x}% , ${y}%) translateZ(${depth}px) rotate(${pose.rotation}deg)`;
}

export function layerOrigin(
  layer: EmblemLayer,
  manifest: EmblemManifest,
): string {
  const [originX, originY, width, height] = manifest.viewBox;
  const x =
    Number.isFinite(width) && width !== 0
      ? ((layer.anchor.x - originX) / width) * 100
      : 0;
  const y =
    Number.isFinite(height) && height !== 0
      ? ((layer.anchor.y - originY) / height) * 100
      : 0;
  return `${x}% ${y}%`;
}

export function manifestError(manifest: EmblemManifest | null): string | null {
  try {
    if (!manifest || typeof manifest !== 'object')
      return 'Invalid emblem manifest.';
    if (manifest.version !== 1) return 'Unsupported emblem manifest version.';
    const box = manifest.viewBox;
    if (
      !Array.isArray(box) ||
      box.length !== 4 ||
      !Number.isFinite(box[0]) ||
      !Number.isFinite(box[1]) ||
      !Number.isFinite(box[2]) ||
      !Number.isFinite(box[3]) ||
      box[2] <= 0 ||
      box[3] <= 0
    ) {
      return 'Invalid emblem manifest viewBox.';
    }
    const layers = manifest.layers;
    if (!Array.isArray(layers) || layers.length === 0 || layers.length > 32) {
      return 'Emblem manifest must contain between 1 and 32 layers.';
    }
    const ids = new Set<string>();
    for (const candidate of layers as readonly unknown[]) {
      if (!candidate || typeof candidate !== 'object')
        return 'Invalid emblem layer.';
      const layer = candidate as Partial<EmblemLayer>;
      if (
        typeof layer.id !== 'string' ||
        layer.id.trim() === '' ||
        ids.has(layer.id)
      ) {
        return 'Emblem layers require unique, nonempty ids.';
      }
      ids.add(layer.id);
      if (
        typeof layer.file !== 'string' ||
        !/^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.svg$/.test(layer.file) ||
        layer.file.startsWith('/') ||
        layer.file.includes('\\') ||
        layer.file.includes(':') ||
        layer.file.split('/').some((part) => part === '' || part === '..')
      ) {
        return 'Emblem layer file must be a safe relative SVG path.';
      }
      if (
        !Number.isFinite(layer.z) ||
        !finitePoint(layer.anchor) ||
        !finitePose(layer.assembled) ||
        !finitePose(layer.exploded)
      ) {
        return 'Emblem layer contains invalid geometry.';
      }
      if (
        layer.spin !== undefined &&
        layer.spin !== 'clockwise' &&
        layer.spin !== 'counter-clockwise'
      )
        return 'Emblem layer has invalid spin.';
    }
    return null;
  } catch {
    return 'Invalid emblem manifest.';
  }
}

function finitePoint(
  value: unknown,
): value is { readonly x: number; readonly y: number } {
  if (!value || typeof value !== 'object') return false;
  const point = value as { x?: unknown; y?: unknown };
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

function finitePose(value: unknown): value is EmblemPose {
  if (!finitePoint(value)) return false;
  return Number.isFinite((value as { rotation?: unknown }).rotation);
}
