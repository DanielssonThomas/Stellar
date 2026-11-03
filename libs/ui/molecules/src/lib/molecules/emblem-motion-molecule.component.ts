import {
  afterNextRender,
  afterRenderEffect,
  Component,
  computed,
  DestroyRef,
  DOCUMENT,
  ElementRef,
  inject,
  input,
  output,
  signal,
  viewChildren,
  viewChild,
} from '@angular/core';
import { motionDurations, type Phase } from '@stellar/desktop-interaction';
import { SkeletonAtom } from '@stellar/ui-atoms';
import clsx from 'clsx';
import { createEmblemLayerMotion } from './emblem-layer-motion';
import { cameraTransform, idleMotionEnabled } from './emblem-camera';
import { createEmblemAmbientMotion } from './emblem-ambient-motion';
import {
  musicTransform,
  silentEmblemMusic,
  type EmblemMusicLevels,
} from './emblem-music-motion';
import { emblemClipPath } from './emblem-clip';
import { emblemImageSource } from './emblem-image-sources';
import { createEmblemImagePreparation } from './emblem-image-preparation';
import {
  clampAudioLevel,
  EmblemManifest,
  layerOrigin,
  layerTransform,
  manifestError,
  isExplodedPhase,
  consolidatedClipFiles,
  consolidatedFragmentFiles,
} from './emblem-motion-model';

let nextEmblemIdentity = 0;

@Component({
  selector: 'stellar-emblem-motion-molecule',
  standalone: true,
  imports: [SkeletonAtom],
  templateUrl: './emblem-motion-molecule.component.html',
  styleUrl: './emblem-motion-molecule.component.css',
  host: {
    '[attr.aria-busy]': 'loading() || (!unavailable() && awaitingSize())',
  },
})
export class EmblemMotionMolecule {
  readonly solMaskId = `sol-stars-${++nextEmblemIdentity}`;
  readonly solStars = [
    'translate(640 130)',
    'translate(1150 640)',
    'translate(640 1150)',
    'translate(130 640)',
  ];
  readonly manifest = input<EmblemManifest | null>(null);
  readonly assetBasePath = input('');
  readonly phase = input<Phase>('idle');
  readonly fault = input(false);
  readonly assetUnavailable = output<void>();
  readonly posePhase = computed(() => (this.fault() ? 'idle' : this.phase()));
  readonly faultFilterId = `${this.solMaskId}-fault`;
  readonly faultLightFilterId = `${this.solMaskId}-fault-light`;
  readonly audioLevel = input(0);
  readonly musicLevels = input<EmblemMusicLevels>(silentEmblemMusic);
  readonly waiting = input(false);
  readonly solActive = input(false);
  readonly reducedMotion = input(false);
  readonly loading = input(false);
  readonly error = input<string | null>(null);
  readonly active = input(true);
  readonly environment = input(false);
  readonly label = input('Stellar emblem');

  private readonly document = inject(DOCUMENT);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly imageWidth = signal(0);
  readonly imageSizes = computed(() => `${this.imageWidth()}px`);
  readonly awaitingSize = computed(
    () =>
      Boolean(this.manifest()?.rasterSizes?.length) && this.imageWidth() <= 0,
  );
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
  private readonly musicPieces =
    viewChildren<ElementRef<HTMLElement>>('musicPiece');
  private readonly images =
    viewChildren<ElementRef<HTMLImageElement>>('emblemImage');
  private readonly preparation = createEmblemImagePreparation(
    this.document.defaultView,
  );
  private readonly settledPhase = signal<Phase | null>(null);
  private readonly motion = createEmblemLayerMotion(
    this.document.defaultView,
    () => this.settledPhase.set(this.posePhase()),
  );
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
      this.posePhase() === 'suspended' ||
      this.posePhase() === 'shutdown' ||
      this.motionReduced(),
  );
  readonly motionReduced = computed(
    () => this.reducedMotion() || this.systemReduced(),
  );
  readonly level = computed(() => clampAudioLevel(this.audioLevel()));
  readonly showWaiting = computed(
    () =>
      !this.fault() &&
      this.waiting() &&
      this.active() &&
      this.visible() &&
      !['suspended', 'shutdown'].includes(this.posePhase()),
  );
  readonly assembled = computed(
    () =>
      !isExplodedPhase(this.posePhase()) &&
      this.settledPhase() === this.posePhase(),
  );
  readonly showSol = computed(
    () =>
      !this.fault() &&
      this.solActive() &&
      this.active() &&
      this.visible() &&
      this.assembled(),
  );
  readonly classes = computed(() =>
    clsx('emblem relative block h-full w-full', {
      'motion-paused': this.paused(),
      'motion-reduced': this.motionReduced(),
      'render-active': !this.paused(),
      'waiting-response': this.showWaiting(),
      'sol-identity': this.solActive(),
      'with-environment': this.environment(),
      'idle-motion':
        !this.fault() && idleMotionEnabled(this.posePhase(), this.paused()),
      'fault-identity': this.fault(),
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
    const unified =
      this.settledPhase() === this.posePhase() &&
      !isExplodedPhase(this.posePhase());
    const drawn = new Set<string>();
    const completeFiles = unified
      ? consolidatedClipFiles(manifest)
      : new Set<string>();
    const fragmentFiles = unified
      ? consolidatedFragmentFiles(manifest)
      : new Set<string>();
    return manifest.layers.map((layer) => {
      let file = layer.file;
      let clipPath = emblemClipPath(layer.clip, manifest.viewBox);
      // A single original avoids fractional clip-edge seams after assembly settles.
      if (unified && layer.clip && completeFiles.has(layer.file)) {
        clipPath = drawn.has(layer.file) ? 'inset(100%)' : 'none';
        drawn.add(layer.file);
      }
      if (layer.assembly && fragmentFiles.has(layer.assembly.file)) {
        file = layer.assembly.file;
        clipPath = drawn.has(file) ? 'inset(100%)' : 'none';
        drawn.add(file);
      }
      return {
        ...layer,
        ...emblemImageSource(file, base, manifest),
        origin: layerOrigin(layer, manifest),
        clipPath,
      };
    });
  });
  readonly assemblySources = computed(() => {
    const manifest = this.manifest();
    if (!manifest || this.unavailable() || this.loading()) return [];
    const base = this.assetBasePath();
    return [
      ...new Set(
        manifest.layers.flatMap((layer) =>
          layer.assembly ? [layer.assembly.file] : [],
        ),
      ),
    ].map((file) => emblemImageSource(file, base, manifest));
  });

  constructor() {
    let sizeObserver: ResizeObserver | undefined;
    const measure = () => {
      const width = this.host.nativeElement.clientWidth;
      if (width > 0) this.imageWidth.set(width);
    };
    afterNextRender(() => {
      measure();
      if (typeof ResizeObserver !== 'undefined') {
        sizeObserver = new ResizeObserver(measure);
        sizeObserver.observe(this.host.nativeElement);
      }
      this.document.defaultView?.addEventListener('resize', measure);
    });
    const visibilityChanged = () =>
      this.visible.set(this.document.visibilityState !== 'hidden');
    const preferenceChanged = () =>
      this.systemReduced.set(this.media?.matches ?? false);
    this.document.addEventListener('visibilitychange', visibilityChanged);
    this.media?.addEventListener('change', preferenceChanged);
    inject(DestroyRef).onDestroy(() => {
      sizeObserver?.disconnect();
      this.document.defaultView?.removeEventListener('resize', measure);
      this.document.removeEventListener('visibilitychange', visibilityChanged);
      this.media?.removeEventListener('change', preferenceChanged);
      this.motion.dispose();
      this.ambient.dispose();
      this.preparation.dispose();
    });
    afterRenderEffect(() => {
      const manifest = this.manifest();
      const layers = this.layers();
      const phase = this.posePhase();
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
        paused
          ? 0
          : this.fault()
            ? 1000
            : phase === 'returning'
              ? motionDurations.return
              : motionDurations.focus,
      );
      this.settledPhase.set(this.motion.settled() ? phase : null);
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
        !this.fault() && idleMotionEnabled(phase, paused),
        paused,
      );
    });
    afterRenderEffect(() => {
      this.layers();
      this.assemblySources();
      this.imageSizes();
      this.prepareImages();
    });
    afterRenderEffect(() => {
      const layers = this.layers();
      const levels =
        !this.fault() && idleMotionEnabled(this.posePhase(), this.paused())
          ? this.musicLevels()
          : silentEmblemMusic;
      for (const [index, piece] of this.musicPieces().entries()) {
        const layer = layers[index];
        if (layer)
          piece.nativeElement.style.transform = musicTransform(
            layer,
            index,
            levels,
          );
      }
    });
  }

  prepareImages() {
    if (
      this.loading() ||
      this.unavailable() ||
      !this.active() ||
      !this.visible() ||
      this.posePhase() === 'suspended' ||
      this.posePhase() === 'shutdown'
    ) {
      this.preparation.cancel();
      return;
    }
    this.preparation.schedule(
      this.images().map((image) => image.nativeElement),
    );
  }

  assetFailed() {
    this.assetUnavailable.emit();
    this.failedAsset.set({
      manifest: this.manifest(),
      base: this.assetBasePath(),
    });
  }
}
