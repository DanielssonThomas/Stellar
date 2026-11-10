import {
  afterRenderEffect,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { SkeletonAtom } from '@stellar/ui-atoms';
import type {
  PresentationImage,
  PresentationMediaPayload,
} from './presentation-model';
import { PRESENTATION_EDIT, PRESENTATION_SELECT } from './presentation-edit';
import {
  PRESENTATION_WORKSPACE,
  type BrowserPane,
  type BrowserView,
} from './presentation-workspace';

export function isBundledBriefingArtwork(value: unknown): value is string {
  return typeof value === 'string' && /^\/briefing\/[a-z-]+\.svg$/u.test(value);
}

@Component({
  selector: 'stellar-presentation-media-molecule',
  standalone: true,
  imports: [SkeletonAtom],
  templateUrl: './presentation-media-molecule.component.html',
  styleUrl: './presentation-media-molecule.component.css',
  host: {
    '[attr.aria-busy]': 'pending()',
    '[attr.data-render-state]': 'renderState()',
  },
})
export class PresentationMediaMolecule {
  readonly payload = input<PresentationMediaPayload | null>(null);
  readonly loading = input(false);
  readonly thumbnail = input<PresentationImage | null>(null);
  private readonly workspace = inject(PRESENTATION_WORKSPACE);
  private readonly edit = inject(PRESENTATION_EDIT);
  private readonly selectPane = inject(PRESENTATION_SELECT);
  private readonly browserBody =
    viewChild<ElementRef<HTMLElement>>('browserBody');
  private browser: BrowserPane | null = null;
  private browserElement: HTMLElement | null = null;
  private browserUrl = '';
  private browserRefresh = 0;
  private imageAbort: AbortController | null = null;
  private imageSource = '';
  readonly browserState = signal<BrowserView | null>(null);
  readonly displaySrc = signal<string | null>(null);
  readonly failed = signal(false);
  readonly loaded = signal(false);
  readonly pan = signal({ x: 0, y: 0 });
  private drag: { x: number; y: number; px: number; py: number } | null = null;
  readonly image = computed(() => {
    const p = this.payload();
    return p?.kind === 'image' ? p : null;
  });
  readonly images = computed(() => {
    const p = this.image();
    return p ? (p.images ?? [p]) : [];
  });
  readonly selected = computed(() => this.image()?.selected ?? 0);
  readonly current = computed(
    () => this.thumbnail() ?? this.images()[this.selected()] ?? null,
  );
  readonly zoom = computed(() => this.image()?.zoom ?? 1);
  readonly pending = computed(
    () =>
      this.loading() ||
      (!!this.current() && !this.loaded() && !this.failed()) ||
      !!this.browserState()?.pending,
  );
  readonly renderState = computed(() => {
    if (this.failed() || this.browserState()?.error) return 'error';
    if (this.pending()) return 'loading';
    if (this.payload()?.kind === 'browser' && !this.browserState())
      return 'loading';
    return this.payload() || this.thumbnail() ? 'ready' : 'unavailable';
  });

  constructor() {
    afterRenderEffect(() => {
      const source = this.current()?.src ?? '';
      if (source === this.imageSource) return;
      this.imageSource = source;
      this.imageAbort?.abort();
      this.pan.set({ x: 0, y: 0 });
      this.loaded.set(false);
      this.failed.set(false);
      this.displaySrc.set(null);
      if (!source) return;
      if (this.thumbnail() && isBundledBriefingArtwork(source)) {
        this.displaySrc.set(source);
        return;
      }
      const controller = new AbortController();
      this.imageAbort = controller;
      void this.workspace
        .preview(source, controller.signal)
        .then((src) => {
          if (!controller.signal.aborted) this.displaySrc.set(src);
        })
        .catch(() => {
          if (!controller.signal.aborted) this.failed.set(true);
        });
    });
    afterRenderEffect(() => {
      const element = this.browserBody()?.nativeElement;
      const content = this.payload();
      if (!element || content?.kind !== 'browser') {
        this.browser?.dispose();
        this.browser = null;
        this.browserElement = null;
        return;
      }
      if (element !== this.browserElement) {
        this.browser?.dispose();
        this.browserElement = element;
        this.browserUrl = content.url;
        this.browserRefresh = content.refresh ?? 0;
        this.browser = this.workspace.browser(element, content.url, (state) => {
          if (state.focused) this.selectPane();
          this.browserState.set(state);
          const payload = this.payload();
          if (
            !state.pending &&
            !state.error &&
            payload?.kind === 'browser' &&
            payload.url !== state.url
          ) {
            this.browserUrl = state.url;
            this.edit({ ...payload, url: state.url });
          }
        });
        if (!this.browser)
          this.browserState.set({
            url: content.url,
            pending: false,
            error:
              'Embedded browsing requires the native desktop. Open this page externally.',
          });
      } else if (content.url !== this.browserUrl) {
        this.browserUrl = content.url;
        this.browser?.navigate(content.url);
      } else if ((content.refresh ?? 0) !== this.browserRefresh) {
        this.browserRefresh = content.refresh ?? 0;
        this.browser?.control('reload');
      }
    });
    inject(DestroyRef).onDestroy(() => {
      this.imageAbort?.abort();
      this.browser?.dispose();
    });
  }
  settle(event: Event, failed: boolean) {
    const src =
      event.target instanceof HTMLImageElement
        ? event.target.getAttribute('src')
        : null;
    if (src && src === this.displaySrc()) {
      this.failed.set(failed);
      this.loaded.set(true);
    }
  }
  select(index: number) {
    const p = this.image();
    if (p && index >= 0 && index < this.images().length)
      this.edit({ ...p, selected: index, zoom: 1 });
  }
  setZoom(value: number) {
    const p = this.image();
    if (p) {
      this.pan.set({ x: 0, y: 0 });
      this.edit({ ...p, zoom: Math.max(1, Math.min(4, value)) });
    }
  }
  beginPan(event: PointerEvent) {
    if (this.zoom() <= 1 || !(event.currentTarget instanceof HTMLElement))
      return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    this.drag = {
      x: event.clientX,
      y: event.clientY,
      px: this.pan().x,
      py: this.pan().y,
    };
  }
  movePan(event: PointerEvent) {
    if (!this.drag || !(event.currentTarget instanceof HTMLElement)) return;
    const b = event.currentTarget.getBoundingClientRect(),
      limitX = (b.width * (this.zoom() - 1)) / 2,
      limitY = (b.height * (this.zoom() - 1)) / 2;
    this.pan.set({
      x: Math.max(
        -limitX,
        Math.min(limitX, this.drag.px + event.clientX - this.drag.x),
      ),
      y: Math.max(
        -limitY,
        Math.min(limitY, this.drag.py + event.clientY - this.drag.y),
      ),
    });
  }
  endPan() {
    this.drag = null;
  }
  control(action: 'back' | 'forward' | 'reload') {
    this.browser?.control(action);
  }
  external(url: string) {
    void this.workspace.external(url).catch(() =>
      this.browserState.set({
        url,
        pending: false,
        error: 'External open is unavailable.',
      }),
    );
  }
}
