import { NgComponentOutlet } from '@angular/common';
import {
  afterRenderEffect,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  input,
  output,
  signal,
  viewChild,
  viewChildren,
} from '@angular/core';
import type {
  SpatialAction,
  SpatialScene,
  SpatialState,
} from '@stellar/desktop-interaction';
import { initialSpatialState } from '@stellar/desktop-interaction';
import { SkeletonAtom } from '@stellar/ui-atoms';
import { PresentationMediaMolecule } from '@stellar/ui-molecules';
import clsx from 'clsx';
import { STAGE_CATALOGUE } from './stage-catalogue';
import { spatialBand, spatialEmblem, spatialLayout } from './spatial-layout';
import { createSpatialMotion } from './spatial-motion';

@Component({
  selector: 'stellar-spatial-presentation-organism',
  imports: [NgComponentOutlet, SkeletonAtom, PresentationMediaMolecule],
  templateUrl: './spatial-presentation-organism.component.html',
  styleUrls: [
    './spatial-presentation-organism.component.css',
    './spatial-presentation-cards.css',
    './spatial-presentation-context.css',
    './spatial-presentation-motion.css',
  ],
  host: {
    '[class.motion-reduced]': 'reducedMotion()',
    '(document:pointerdown)': 'outsideContext($event)',
  },
})
export class SpatialPresentationOrganism {
  readonly scene = input<SpatialScene | null>(null);
  readonly state = input<SpatialState>(initialSpatialState);
  readonly reducedMotion = input(false);
  readonly loading = input(false);
  readonly mode = input<
    'idle' | 'preparing' | 'speaking' | 'silent' | 'reading' | 'paused'
  >('idle');
  readonly caption = input('');
  readonly transcript = input<readonly string[]>([]);
  readonly action = output<SpatialAction>();
  readonly stop = output();
  readonly next = output();
  readonly toggleReadAlong = output();
  readonly follow = output();
  readonly compact = signal(false);
  private readonly title = viewChild<ElementRef<HTMLElement>>('title');
  readonly contextOpen = signal(false);
  readonly transcriptOpen = signal(false);
  readonly readAlong = computed(
    () => this.mode() === 'reading' || this.mode() === 'paused',
  );
  private readonly contextTrigger =
    viewChild<ElementRef<HTMLButtonElement>>('contextTrigger');
  private readonly context = viewChild<ElementRef<HTMLElement>>('context');
  private readonly viewport = viewChild<ElementRef<HTMLElement>>('viewport');
  private readonly cards = viewChildren<ElementRef<HTMLElement>>('card');
  private readonly size = signal({ width: 0, height: 0 });
  private readonly catalogue = inject(STAGE_CATALOGUE);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly motion = createSpatialMotion();
  private readonly view = this.host.nativeElement.ownerDocument.defaultView;
  private readonly motionPreference = this.view?.matchMedia?.(
    '(prefers-reduced-motion: reduce)',
  );
  private readonly systemReduced = signal(
    this.motionPreference?.matches ?? false,
  );
  readonly band = computed(() =>
    spatialBand(this.size().width, this.size().height),
  );
  readonly placements = computed(() => {
    const { width, height } = this.size();
    return spatialLayout(this.state(), width, this.compact(), height);
  });
  readonly fieldHeight = computed(() =>
    Math.max(0, ...this.placements().map((slot) => slot.y + slot.height + 12)),
  );
  readonly connector = computed(() => {
    const featured = this.state().featured;
    const { width, height } = this.size();
    const slot = this.placements().find((panel) => panel.id === featured[0]);
    if (featured.length !== 1 || !slot) return '';
    const emblem = spatialEmblem(width, height, featured.length);
    const x = slot.x + slot.width + 12;
    const end = emblem.x - 14;
    const y = emblem.y + emblem.height / 2 - this.band().top;
    return end - x > 22 && y > slot.y && y < slot.y + slot.height
      ? `M ${x} ${y} H ${end}`
      : '';
  });
  readonly panels = computed(() => {
    const state = this.state();
    const positions = new Map(this.placements().map((slot) => [slot.id, slot]));
    return state.panels.flatMap((panel, index) => {
      const slot = positions.get(panel.id);
      if (!slot) return [];
      const expanded =
        state.expanded.includes(panel.id) && slot.depth !== 'periphery';
      const detail = panel.detail && this.catalogue[panel.detail.surface];
      return [
        {
          ...panel,
          ...slot,
          index,
          expanded,
          focused: state.featured.includes(panel.id),
          renderer: detail && {
            component: detail.component,
            inputs: { payload: panel.detail?.payload },
          },
          classes: clsx('spatial-card', slot.depth, {
            'is-focused': state.featured.includes(panel.id),
            'is-expanded': expanded,
          }),
        },
      ];
    });
  });

  constructor() {
    const destroy = inject(DestroyRef);
    let observed: HTMLElement | undefined;
    let observer: ResizeObserver | undefined;
    let lastScene: SpatialScene | null = null;
    let lastFocus = '';
    const preference = () =>
      this.systemReduced.set(this.motionPreference?.matches ?? false);
    this.motionPreference?.addEventListener('change', preference);
    afterRenderEffect(() => {
      const viewport = this.viewport()?.nativeElement;
      if (viewport !== observed) {
        observer?.disconnect();
        observed = viewport;
        if (viewport) {
          const host = this.host.nativeElement;
          const measure = () =>
            this.size.set({
              width: host.clientWidth,
              height: host.clientHeight,
            });
          measure();
          if (typeof ResizeObserver !== 'undefined') {
            observer = new ResizeObserver(measure);
            observer.observe(host);
          }
        }
      }
      const current = this.size().width ? this.scene() : null;
      if (current && !lastScene)
        this.title()?.nativeElement.focus({ preventScroll: true });
      else if (!current && lastScene) this.closeContext(false);
      lastScene = current;
      const focus = this.state().featured.join(':');
      if (viewport && focus !== lastFocus) viewport.scrollTop = 0;
      lastFocus = focus;
    });
    afterRenderEffect(() => {
      this.motion.update(
        this.placements(),
        this.cards().map((card) => card.nativeElement),
        this.reducedMotion() || this.systemReduced(),
      );
    });
    destroy.onDestroy(() => {
      observer?.disconnect();
      this.motionPreference?.removeEventListener('change', preference);
      this.motion.dispose();
    });
  }

  activatePanel(id: string, hasDetail: boolean, expanded: boolean) {
    const featured = this.state().featured;
    if (featured.length !== 1 || featured[0] !== id) {
      this.action.emit({ kind: 'focus', id });
    } else if (hasDetail) {
      this.action.emit({ kind: expanded ? 'collapse' : 'expand', id });
    }
  }

  toggleContext() {
    if (this.contextOpen()) this.closeContext();
    else this.contextOpen.set(true);
  }

  closeContext(restore = true) {
    if (!this.contextOpen()) return;
    this.contextOpen.set(false);
    this.transcriptOpen.set(false);
    if (restore)
      this.contextTrigger()?.nativeElement.focus({ preventScroll: true });
  }

  outsideContext(event: Event) {
    if (!this.contextOpen() || !(event.target instanceof Node)) return;
    if (!this.context()?.nativeElement.contains(event.target))
      this.closeContext(false);
  }

  contextAction(action: SpatialAction) {
    this.closeContext();
    this.action.emit(action);
  }

  dismiss(id: string, event: Event) {
    event.preventDefault();
    event.stopPropagation();
    this.title()?.nativeElement.focus({ preventScroll: true });
    this.action.emit({ kind: 'dismiss', id });
  }

  shortcut(event: KeyboardEvent) {
    if (
      event.defaultPrevented ||
      event.repeat ||
      event.isComposing ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      (event.target instanceof Element &&
        event.target.closest('input, textarea, select, [contenteditable]'))
    )
      return;
    const key = event.key.toLowerCase();
    if (key === 's' && event.altKey && this.mode() !== 'idle') {
      event.preventDefault();
      this.closeContext();
      this.stop.emit();
    } else if (key === 'f' && !event.altKey && this.state().manual) {
      event.preventDefault();
      this.closeContext();
      this.follow.emit();
    }
  }

  escape(event: Event) {
    event.stopPropagation();
    event.preventDefault();
    if (this.contextOpen()) this.closeContext();
    else
      this.action.emit({
        kind: this.state().featured.length ? 'overview' : 'clear',
      });
  }
}
