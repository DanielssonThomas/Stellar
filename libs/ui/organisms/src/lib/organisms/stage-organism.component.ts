import { NgComponentOutlet } from '@angular/common';
import {
  afterNextRender,
  afterRenderEffect,
  type AnimationCallbackEvent,
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
} from '@angular/core';
import type {
  EmblemTarget,
  InteractionEvent,
} from '@stellar/desktop-interaction';
import { motionDurations } from '@stellar/desktop-interaction';
import { SkeletonAtom } from '@stellar/ui-atoms';
import clsx from 'clsx';
import { STAGE_CATALOGUE } from './stage-catalogue';
import { StageResult } from './stage-contract';
import { directStage } from './stage-director';
import { createStageRegistry } from './stage-registry';
import { createStageMotion } from './stage-motion';

@Component({
  selector: 'stellar-stage-organism',
  standalone: true,
  imports: [SkeletonAtom, NgComponentOutlet],
  templateUrl: './stage-organism.component.html',
  styleUrl: './stage-organism.component.css',
  host: {
    '[attr.aria-busy]': 'loading()',
    '[class.motion-reduced]': 'reducedMotion()',
    '[class.keyboard-focus]': 'keyboardFocus()',
    '(keydown.tab)': 'keyboardFocus.set(true)',
    '(pointerdown)': 'keyboardFocus.set(false)',
    '(keydown.escape)': 'escape($event)',
  },
})
export class StageOrganism {
  readonly keyboardFocus = signal(false);
  readonly loading = input(false);
  readonly emblemTarget = input<EmblemTarget>();
  readonly reducedMotion = input(false);
  readonly dismissOnClose = input(true);
  readonly focusFallback = input<HTMLElement | null>(null);
  readonly presentationChange = output<boolean>();
  readonly retainedPresentations = output<boolean>();
  readonly interaction = output<InteractionEvent>();
  readonly motionDuration = computed(() => {
    const target = this.emblemTarget();
    return `${target === 'docked' ? motionDurations.dock : target === 'center' ? motionDurations.return : motionDurations.focus}ms`;
  });
  private readonly catalogue = Object.freeze({ ...inject(STAGE_CATALOGUE) });
  private readonly registry = createStageRegistry<Record<string, unknown>>(
    Object.fromEntries(
      Object.entries(this.catalogue).map(([kind, entry]) => [
        kind,
        entry.decode,
      ]),
    ),
  );
  private readonly document = inject(DOCUMENT);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly panels = viewChildren<ElementRef<HTMLElement>>('panel');
  private readonly motion = createStageMotion(this.document.defaultView);
  private readonly origins = new Map<string, HTMLElement>();
  private readonly focusRequest = signal<{
    instanceId: string;
    descendant?: HTMLElement;
  } | null>(null);
  private readonly viewport = signal({ width: 0, height: 0 });
  private readonly instances = signal(this.registry.snapshot());
  readonly layout = computed(() =>
    directStage(this.viewport(), this.instances(), this.emblemTarget()),
  );
  readonly surfaces = computed(() =>
    this.layout().surfaces.flatMap((rect) => {
      const instance = this.instances().find(
        (entry) => entry.instanceId === rect.instanceId,
      );
      if (!instance) return [];
      const definition = this.catalogue[instance.surface];
      return [
        {
          ...rect,
          ...definition,
          inputs: { payload: instance.payload },
          classes: clsx('surface text-stellar-foreground', {
            'primary-surface': instance.prominence === 'primary',
            'boundary-left': rect.x > 0,
            'boundary-top': rect.y > 0,
            'emblem-reserve':
              rect.x + rect.width > this.layout().emblem.x &&
              rect.y + rect.height > this.layout().emblem.y,
          }),
        },
      ];
    }),
  );

  constructor() {
    let observer: ResizeObserver | undefined;
    const measure = () => {
      const bounds = this.host.nativeElement.getBoundingClientRect();
      this.motion.capture(this.panels().map((panel) => panel.nativeElement));
      this.viewport.set({ width: bounds.width, height: bounds.height });
    };
    afterNextRender(() => {
      measure();
      if (typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver(measure);
        observer.observe(this.host.nativeElement);
      }
      this.document.defaultView?.addEventListener('resize', measure);
    });
    afterRenderEffect(() => {
      const surfaces = this.surfaces();
      this.motion.update(
        this.panels().flatMap((panel) => {
          if (panel.nativeElement.classList.contains('pane-leave')) return [];
          const surface = surfaces.find(
            (surface) =>
              surface.instanceId === panel.nativeElement.dataset['instanceId'],
          );
          return surface ? [{ ...surface, element: panel.nativeElement }] : [];
        }),
        this.reducedMotion() ||
          (this.document.defaultView?.matchMedia?.(
            '(prefers-reduced-motion: reduce)',
          ).matches ??
            false),
      );
    });
    afterRenderEffect(() => {
      const requested = this.focusRequest();
      if (!requested || this.loading()) return;
      const panel = this.panels().find(
        (entry) =>
          entry.nativeElement.dataset['instanceId'] === requested.instanceId,
      );
      if (panel) {
        const target = requested.descendant;
        (target?.isConnected && panel.nativeElement.contains(target)
          ? target
          : panel.nativeElement
        ).focus({ preventScroll: true });
        this.focusRequest.set(null);
      }
    });
    inject(DestroyRef).onDestroy(() => {
      observer?.disconnect();
      this.document.defaultView?.removeEventListener('resize', measure);
      const active = this.document.activeElement;
      if (active && this.host.nativeElement.contains(active)) {
        const origin = [...this.origins.values()].find(
          (element) =>
            element.isConnected && !this.host.nativeElement.contains(element),
        );
        origin?.focus();
      }
      this.origins.clear();
      this.motion.dispose();
      this.registry.dispose();
    });
  }

  dispatch(command: unknown): StageResult {
    this.motion.capture(this.panels().map((panel) => panel.nativeElement));
    const origin = this.document.activeElement;
    const result = this.registry.dispatch(command);
    if (result.status === 'applied' && result.action === 'open')
      this.keyboardFocus.set(false);
    if (
      result.status === 'applied' &&
      result.action === 'open' &&
      result.instanceId &&
      origin instanceof HTMLElement
    )
      this.origins.set(result.instanceId, origin);
    this.afterAction(result);
    return result;
  }

  control(action: 'focus' | 'minimize' | 'close', instanceId: string) {
    this.motion.capture(this.panels().map((panel) => panel.nativeElement));
    this.afterAction(this.registry.interact(action, instanceId));
  }

  retire(event: AnimationCallbackEvent) {
    if (!(event.target instanceof HTMLElement)) {
      event.animationComplete();
      return;
    }
    this.motion.retire(
      event.target,
      this.layout().surfaces,
      this.reducedMotion() ||
        (this.document.defaultView?.matchMedia?.(
          '(prefers-reduced-motion: reduce)',
        ).matches ??
          false),
      () => event.animationComplete(),
    );
  }

  closePresentations() {
    for (const instance of this.registry.snapshot())
      this.control('close', instance.instanceId);
  }

  presentationIds(): readonly string[] {
    return this.registry.snapshot().map((instance) => instance.instanceId);
  }

  restorePresentation() {
    const instances = this.registry.snapshot();
    const instance = instances.find((entry) => entry.minimized) ?? instances[0];
    if (instance) this.control('focus', instance.instanceId);
  }

  escape(event: Event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const panel = target.closest<HTMLElement>('[data-instance-id]');
    const id = panel?.dataset['instanceId'];
    if (id && this.host.nativeElement.contains(panel)) {
      event.preventDefault();
      event.stopPropagation();
      this.control('close', id);
    }
  }

  private afterAction(result: StageResult) {
    if (result.status !== 'applied') return;
    const { instanceId, action } = result;
    if (action === 'arrange') {
      const activePanel = this.panels().find((entry) =>
        entry.nativeElement.contains(this.document.activeElement),
      );
      const instanceId = activePanel?.nativeElement.dataset['instanceId'];
      const active = this.document.activeElement;
      if (instanceId && active instanceof HTMLElement)
        this.focusRequest.set({ instanceId, descendant: active });
    }
    if (action === 'clear') {
      const focusedPanel = this.panels().find((entry) =>
        entry.nativeElement.contains(this.document.activeElement),
      )?.nativeElement;
      let origin = focusedPanel?.dataset['instanceId']
        ? this.origins.get(focusedPanel.dataset['instanceId'])
        : undefined;
      const visited = new Set<HTMLElement>();
      while (
        origin &&
        this.host.nativeElement.contains(origin) &&
        !visited.has(origin)
      ) {
        visited.add(origin);
        const parent = origin.closest<HTMLElement>('[data-instance-id]');
        origin = parent?.dataset['instanceId']
          ? this.origins.get(parent.dataset['instanceId'])
          : undefined;
      }
      if (origin && this.host.nativeElement.contains(origin))
        origin = undefined;
      if (focusedPanel) {
        const target =
          origin?.isConnected && origin !== this.document.body
            ? origin
            : this.focusFallback();
        if (target?.isConnected) target.focus();
      }
      this.origins.clear();
      this.focusRequest.set(null);
      if (this.instances().length && this.dismissOnClose())
        this.interaction.emit({ type: 'dismiss' });
    }
    if (instanceId && (action === 'close' || action === 'minimize')) {
      const panel = this.panels().find(
        (entry) => entry.nativeElement.dataset['instanceId'] === instanceId,
      )?.nativeElement;
      const savedOrigin = this.origins.get(instanceId);
      const origin =
        savedOrigin?.isConnected && savedOrigin !== this.document.body
          ? savedOrigin
          : this.focusFallback();
      if (panel && origin?.isConnected && !panel.contains(origin)) {
        for (const [dependent, savedOrigin] of this.origins) {
          if (panel.contains(savedOrigin)) this.origins.set(dependent, origin);
        }
      }
      if (panel?.contains(this.document.activeElement) && origin?.isConnected)
        origin.focus();
      if (action === 'close') {
        this.origins.delete(instanceId);
        if (this.dismissOnClose()) this.interaction.emit({ type: 'dismiss' });
      }
    }
    this.instances.set(this.registry.snapshot());
    this.retainedPresentations.emit(this.registry.snapshot().length > 0);
    this.presentationChange.emit(
      this.registry.snapshot().some((instance) => !instance.minimized),
    );
    if (instanceId && (action === 'open' || action === 'focus'))
      this.focusRequest.set({ instanceId });
  }
}
