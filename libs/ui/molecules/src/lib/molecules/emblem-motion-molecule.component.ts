import {
  afterRenderEffect,
  Component,
  computed,
  DestroyRef,
  DOCUMENT,
  ElementRef,
  inject,
  input,
  signal,
  viewChildren,
  viewChild,
} from '@angular/core';
import type { Phase } from '@stellar/desktop-interaction';
import { SkeletonAtom } from '@stellar/ui-atoms';
import clsx from 'clsx';
import { createEmblemLayerMotion } from './emblem-layer-motion';
import { cameraTransform, idleMotionEnabled } from './emblem-camera';
import { createEmblemAmbientMotion } from './emblem-ambient-motion';
import {
  clampAudioLevel,
  EmblemManifest,
  layerOrigin,
  layerTransform,
  manifestError,
} from './emblem-motion-model';

@Component({
  selector: 'stellar-emblem-motion-molecule',
  standalone: true,
  imports: [SkeletonAtom],
  templateUrl: './emblem-motion-molecule.component.html',
  styleUrl: './emblem-motion-molecule.component.css',
  host: { '[attr.aria-busy]': 'loading()' },
})
export class EmblemMotionMolecule {
  readonly manifest = input<EmblemManifest | null>(null);
  readonly assetBasePath = input('');
  readonly phase = input<Phase>('idle');
  readonly audioLevel = input(0);
  readonly reducedMotion = input(false);
  readonly loading = input(false);
  readonly error = input<string | null>(null);
  readonly active = input(true);
  readonly environment = input(false);
  readonly label = input('Stellar emblem');

  private readonly document = inject(DOCUMENT);
  private readonly visible = signal(this.document.visibilityState !== 'hidden');
  private readonly media = this.document.defaultView?.matchMedia?.(
    '(prefers-reduced-motion: reduce)',
  );
  private readonly systemReduced = signal(this.media?.matches ?? false);
  private readonly failedAsset = signal<{
    manifest: EmblemManifest | null;
    base: string;
  } | null>(null);
  private readonly planes = viewChildren<ElementRef<HTMLElement>>('plane');
  private readonly camera = viewChild<ElementRef<HTMLElement>>('camera');
  private readonly artwork = viewChildren<ElementRef<HTMLElement>>('artwork');
  private readonly motion = createEmblemLayerMotion(this.document.defaultView);
  private readonly ambient = createEmblemAmbientMotion(
    this.document.defaultView,
  );

  readonly unavailable = computed(() => {
    const failed = this.failedAsset();
    return Boolean(
      this.error() ||
        manifestError(this.manifest()) ||
        !/^\/?(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]*$/.test(
          this.assetBasePath(),
        ) ||
        (failed &&
          failed.manifest === this.manifest() &&
          failed.base === this.assetBasePath()),
    );
  });
  readonly paused = computed(
    () =>
      !this.active() ||
      !this.visible() ||
      this.phase() === 'suspended' ||
      this.phase() === 'shutdown' ||
      this.motionReduced(),
  );
  readonly motionReduced = computed(
    () => this.reducedMotion() || this.systemReduced(),
  );
  readonly level = computed(() => clampAudioLevel(this.audioLevel()));
  readonly classes = computed(() =>
    clsx('emblem relative block h-full w-full', {
      'motion-paused': this.paused(),
      'with-environment': this.environment(),
      'idle-motion': idleMotionEnabled(this.phase(), this.paused()),
    }),
  );
  readonly aspectRatio = computed(() => {
    const manifest = this.manifest();
    return manifest && !manifestError(manifest)
      ? `${manifest.viewBox[2]} / ${manifest.viewBox[3]}`
      : '1';
  });
  readonly layers = computed(() => {
    const manifest = this.manifest();
    if (!manifest || this.unavailable() || this.loading()) return [];
    const base = this.assetBasePath();
    return manifest.layers.map((layer) => ({
      ...layer,
      src: base
        ? `${base}${base.endsWith('/') ? '' : '/'}${layer.file}`
        : layer.file,
      origin: layerOrigin(layer, manifest),
    }));
  });

  constructor() {
    const visibilityChanged = () =>
      this.visible.set(this.document.visibilityState !== 'hidden');
    const preferenceChanged = () =>
      this.systemReduced.set(this.media?.matches ?? false);
    this.document.addEventListener('visibilitychange', visibilityChanged);
    this.media?.addEventListener('change', preferenceChanged);
    inject(DestroyRef).onDestroy(() => {
      this.document.removeEventListener('visibilitychange', visibilityChanged);
      this.media?.removeEventListener('change', preferenceChanged);
      this.motion.dispose();
      this.ambient.dispose();
    });
    afterRenderEffect(() => {
      const manifest = this.manifest();
      const layers = this.layers();
      const phase = this.phase();
      const reduced = this.motionReduced();
      const paused = this.paused();
      const planes = this.planes();
      const camera = this.camera();
      this.motion.update(
        manifest
          ? [
              ...(camera
                ? [
                    {
                      element: camera.nativeElement,
                      transform: cameraTransform(phase),
                    },
                  ]
                : []),
              ...planes.flatMap((plane, index) => {
                const layer = layers[index];
                return layer
                  ? [
                      {
                        element: plane.nativeElement,
                        transform: layerTransform(
                          layer,
                          manifest,
                          phase,
                          reduced,
                        ),
                      },
                    ]
                  : [];
              }),
            ]
          : [],
        paused ? 0 : phase === 'returning' ? 260 : 220,
      );
      this.ambient.update(
        this.artwork().flatMap((artwork, index) => {
          const layer = layers[index];
          return layer
            ? [
                {
                  element: artwork.nativeElement,
                  spin: layer.spin,
                  order: index,
                },
              ]
            : [];
        }),
        idleMotionEnabled(phase, paused),
        paused,
      );
    });
  }

  assetFailed() {
    this.failedAsset.set({
      manifest: this.manifest(),
      base: this.assetBasePath(),
    });
  }
}
