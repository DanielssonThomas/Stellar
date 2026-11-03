import { layerPlacement, type EmblemManifest } from './emblem-motion-model';

export interface EmblemMusicDirection {
  readonly outward: number;
  readonly inwardX: number;
  readonly inwardY: number;
}

export function emblemMusicDirections(
  manifest: EmblemManifest,
): ReadonlyMap<string, EmblemMusicDirection> {
  const pieces = manifest.layers
    .filter((layer) => !layer.spin)
    .map((layer) => ({
      layer,
      pose: layerPlacement(layer, manifest, 'idle', false),
    }));
  const extent = Math.max(
    1,
    ...pieces.map((piece) => Math.abs(piece.pose.depth)),
  );
  const [x, y, width, height] = manifest.viewBox;
  return new Map(
    pieces.map(({ layer, pose }) => {
      const radians = (layer.exploded.rotation * Math.PI) / 180;
      const cos = Math.cos(radians),
        sin = Math.sin(radians);
      const centroid = layer.centroid ?? layer.anchor;
      const dx = centroid.x - layer.anchor.x,
        dy = centroid.y - layer.anchor.y;
      const centerX =
        layer.anchor.x + dx * cos - dy * sin + (pose.x * width) / 100;
      const centerY =
        layer.anchor.y + dx * sin + dy * cos + (pose.y * height) / 100;
      const towardX = x + width / 2 - centerX,
        towardY = y + height / 2 - centerY;
      return [
        layer.id,
        {
          outward:
            Math.sign(pose.depth) *
            (0.4 + (0.6 * Math.abs(pose.depth)) / extent),
          // Undo the plane's rotation so the pull follows the common depth axis.
          inwardX: ((towardX * cos + towardY * sin) / width) * 20,
          inwardY: ((-towardX * sin + towardY * cos) / height) * 20,
        },
      ];
    }),
  );
}
