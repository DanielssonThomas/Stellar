import type { EmblemManifest } from './emblem-motion-model';

export function emblemImageSource(
  file: string,
  base: string,
  manifest: EmblemManifest,
) {
  const url = (path: string) =>
    base ? `${base}${base.endsWith('/') ? '' : '/'}${path}` : path;
  return {
    src: url(file),
    srcset:
      file.endsWith('.png') && manifest.rasterSizes?.length
        ? [
            ...manifest.rasterSizes.map(
              (size) => `${url(`resolutions/${size}/${file}`)} ${size}w`,
            ),
            `${url(file)} ${manifest.viewBox[2]}w`,
          ].join(', ')
        : null,
  };
}
