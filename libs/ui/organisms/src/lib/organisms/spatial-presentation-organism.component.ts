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
import clsx from 'clsx';
import { STAGE_CATALOGUE } from './stage-catalogue';
import { spatialLayout } from './spatial-layout';
import { createSpatialMotion } from './spatial-motion';

@Component({
  selector: 'stellar-spatial-presentation-organism',
  imports: [NgComponentOutlet, SkeletonAtom],
  templateUrl: './spatial-presentation-organism.component.html',
  styleUrls: [
    './spatial-presentation-organism.component.css',
    './spatial-presentation-cards.css',
    './spatial-presentation-motion.css',
  ],
  host: {
    '[class.motion-reduced]': 'reducedMotion()',
  },
})
export class SpatialPresentationOrganism {
  readonly scene = input<SpatialScene | null>(null);
  readonly state = input<SpatialState>(initialSpatialState);
  readonly reducedMotion = input(false);
  readonly loading = input(false);
  readonly mode = input<'idle' | 'preparing' | 'speaking' | 'manual'>('idle');
  readonly caption = input('');
  readonly action = output<SpatialAction>();
  readonly stop = output();
  readonly next = output();
  readonly follow = output();
  readonly compact = signal(false);
  private readonly title = viewChild<ElementRef<HTMLElement>>('title');
  private readonly overview =
    viewChild<ElementRef<HTMLButtonElement>>('overview');
  private readonly viewport = viewChild<ElementRef<HTMLElement>>('viewport');
  private readonly cards = viewChildren<ElementRef<HTMLElement>>('card');
  private readonly width = signal(0);
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
  readonly placements = computed(() =>
    spatialLayout(this.state(), this.width(), this.compact()),
  );
  readonly fieldHeight = computed(() =>
    Math.max(0, ...this.placements().map((slot) => slot.y + slot.height + 32)),
  );
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
          this.width.set(Math.min(1540, viewport.clientWidth));
          if (typeof ResizeObserver !== 'undefined') {
            observer = new ResizeObserver(() =>
              this.width.set(Math.min(1540, viewport.clientWidth)),
            );
            observer.observe(viewport);
          }
        }
      }
      const current = this.scene();
      if (current && !lastScene)
        this.title()?.nativeElement.focus({ preventScroll: true });
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

  toggleCompact() {
    this.compact.update((value) => !value);
  }

  toggleDetails(id: string, expanded: boolean) {
    this.action.emit({ kind: expanded ? 'collapse' : 'expand', id });
  }

  trapTab(event: Event) {
    if (
      !(event instanceof KeyboardEvent) ||
      !(event.currentTarget instanceof HTMLElement)
    )
      return;
    const controls = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>('button, a[href]'),
    ).filter(
      (control) =>
        control.getClientRects().length && !control.closest('[inert]'),
    );
    const first = controls[0];
    const last = controls.at(-1);
    const active = event.currentTarget.ownerDocument.activeElement;
    if (
      event.shiftKey &&
      (active === first || active === this.title()?.nativeElement)
    ) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first?.focus();
    }
  }

  dismiss(id: string, event: MouseEvent) {
    if (
      event.currentTarget instanceof HTMLElement &&
      event.currentTarget
        .closest('article')
        ?.contains(this.host.nativeElement.ownerDocument.activeElement)
    )
      this.overview()?.nativeElement.focus({ preventScroll: true });
    this.action.emit({ kind: 'dismiss', id });
  }

  escape(event: Event) {
    event.stopPropagation();
    event.preventDefault();
    this.action.emit({
      kind: this.state().featured.length ? 'overview' : 'clear',
    });
  }
}
