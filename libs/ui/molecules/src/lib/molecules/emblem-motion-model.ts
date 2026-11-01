import type { Phase } from '@stellar/desktop-interaction';
import { planeDepth } from './emblem-stack';
import {
  completeClipFiles,
  validEmblemClip,
  type EmblemClip,
} from './emblem-clip';

export interface EmblemPose {
  readonly x: number;
  readonly y: number;
  readonly rotation: number;
  readonly depth?: number;
}

export interface EmblemLayer {
  readonly id: string;
  readonly file: string;
  readonly z: number;
  readonly planeIndex?: number;
  readonly clip?: EmblemClip;
  readonly anchor: { readonly x: number; readonly y: number };
  readonly assembled: EmblemPose;
  readonly exploded: EmblemPose;
  readonly spin?: 'clockwise' | 'counter-clockwise';
}

export interface EmblemManifest {
  readonly version: 1;
  readonly viewBox: readonly [number, number, number, number];
  readonly layers: readonly EmblemLayer[];
  readonly planeSpacing?: number;
}

export function consolidatedClipFiles(
  manifest: EmblemManifest,
): ReadonlySet<string> {
  const files = new Set(completeClipFiles(manifest.layers, manifest.viewBox));
  const painted = manifest.layers
    .map((layer, index) => ({ layer, index }))
    .sort((a, b) => a.layer.z - b.layer.z || a.index - b.index);
  for (const file of files) {
    const group = manifest.layers.filter((layer) => layer.file === file);
    const anchor = group[0].anchor;
    const positions = painted.flatMap(({ layer }, index) =>
      layer.file === file ? [index] : [],
    );
    const registered = group.every(
      (layer) =>
        layer.assembled.x === 0 &&
        layer.assembled.y === 0 &&
        layer.assembled.rotation === 0 &&
        (layer.assembled.depth ?? 0) === 0 &&
        layer.anchor.x === anchor.x &&
        layer.anchor.y === anchor.y,
    );
    if (
      !registered ||
      positions[positions.length - 1] - positions[0] + 1 !== group.length
    )
      files.delete(file);
  }
  return files;
}

export function clampAudioLevel(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

export function isExplodedPhase(phase: Phase): boolean {
  return (
    phase === 'idle' ||
    phase === 'returning' ||
    phase === 'suspended' ||
    phase === 'shutdown'
  );
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
  const planeIndex = layer.planeIndex;
  const stacked = planeIndex !== undefined && isExplodedPhase(phase);
  const depth =
    (stacked
      ? planeDepth(planeIndex, layers.length, manifest.planeSpacing)
      : pose.depth) ??
    (reducedMotion || !isExplodedPhase(phase) || maxZ === minZ
      ? 0
      : ((layer.z - (minZ + maxZ) / 2) / (maxZ - minZ)) * 18);
  const width = manifest?.viewBox?.[2];
  const height = manifest?.viewBox?.[3];
  const x = Number.isFinite(width) && width !== 0 ? (pose.x / width) * 100 : 0;
  const y =
    Number.isFinite(height) && height !== 0 ? (pose.y / height) * 100 : 0;
  const depthTransform =
    pose.depth === undefined && !stacked
      ? `translateZ(${depth}px)`
      : `translateZ(${(depth / width) * 100}cqw)`;
  return `translate(${x}% , ${y}%) ${depthTransform} rotate(${pose.rotation}deg)`;
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
    const planeIndices = new Set<number>();
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
      if (!validEmblemClip(layer.clip, manifest.viewBox))
        return 'Invalid emblem clip.';
      if (layer.planeIndex !== undefined) {
        planeDepth(layer.planeIndex, layers.length, manifest.planeSpacing);
        if (planeIndices.has(layer.planeIndex))
          return 'Emblem plane indices must be unique.';
        planeIndices.add(layer.planeIndex);
      }
      if (
        typeof layer.file !== 'string' ||
        !/^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.(?:svg|png|webp)$/.test(
          layer.file,
        ) ||
        layer.file.startsWith('/') ||
        layer.file.includes('\\') ||
        layer.file.includes(':') ||
        layer.file.split('/').some((part) => part === '' || part === '..')
      ) {
        return 'Emblem layer file must be a safe relative SVG, PNG or WebP path.';
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
    if (
      (planeIndices.size || manifest.planeSpacing !== undefined) &&
      planeIndices.size !== layers.length
    )
      return 'Every spaced emblem plane requires an index.';
    return null;
  } catch {
    return 'Invalid emblem manifest.';
  }
}

export function decodeEmblemManifest(value: unknown): EmblemManifest | null {
  const candidate = value as EmblemManifest | null;
  return manifestError(candidate) === null ? candidate : null;
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
  const pose = value as { rotation?: unknown; depth?: unknown };
  return (
    Number.isFinite(pose.rotation) &&
    (pose.depth === undefined ||
      (typeof pose.depth === 'number' &&
        Number.isFinite(pose.depth) &&
        Math.abs(pose.depth) <= 4096))
  );
}
