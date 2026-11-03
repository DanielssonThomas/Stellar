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
  Injector,
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
import { PRESENTATION_EDIT, PRESENTATION_SELECT } from '@stellar/ui-molecules';
import { STAGE_CATALOGUE } from './stage-catalogue';
import { StageResult } from './stage-contract';
import { type StageDivider, directStage } from './stage-director';
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
  readonly composing = input(false);
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
  private readonly parentInjector = inject(Injector);
  private readonly contentInjectors = new Map<string, Injector>();
  readonly resizing = signal(false);
  private drag: {
    divider: StageDivider;
    pointerId: number;
    element: HTMLElement;
  } | null = null;
  private resizeFrame = 0;
  private resizeRatio: number | null = null;
  readonly layoutState = signal(this.registry.layout());
  private readonly viewport = signal({ width: 0, height: 0 });
  private readonly instances = signal(this.registry.snapshot());
  readonly layout = computed(() =>
    directStage(
      this.viewport(),
      this.instances(),
      this.emblemTarget(),
      this.composing(),
      this.layoutState(),
    ),
  );
  readonly surfaces = computed(() =>
    this.instances().map((instance) => {
      const rect = this.layout().surfaces.find(
        (rect) => rect.instanceId === instance.instanceId,
      );
      const definition = this.catalogue[instance.surface];
      let injector = this.contentInjectors.get(instance.instanceId);
      if (!injector) {
        injector = Injector.create({
          parent: this.parentInjector,
          providers: [
            {
              provide: PRESENTATION_EDIT,
              useValue: (payload: unknown) => {
                if (this.contentInjectors.get(instance.instanceId) === injector)
                  this.afterAction(
                    this.registry.edit(instance.instanceId, payload),
                  );
              },
            },
            {
              provide: PRESENTATION_SELECT,
              useValue: () => {
                if (this.contentInjectors.get(instance.instanceId) === injector)
                  this.select(instance.instanceId);
              },
            },
          ],
        });
        this.contentInjectors.set(instance.instanceId, injector);
      }
      return {
        ...definition,
        ...instance,
        ...(rect ?? { x: 0, y: 0, width: 0, height: 0 }),
        title:
          typeof (instance.payload as Record<string, unknown>)?.['title'] ===
          'string'
            ? String((instance.payload as Record<string, unknown>)['title'])
            : definition.title,
        hidden: !rect,
        injector,
        inputs: { payload: instance.payload },
        classes: clsx('surface text-stellar-foreground', {
          'selected-surface':
            this.layoutState().focusedId === instance.instanceId,
          'primary-surface': instance.prominence === 'primary',
          'boundary-left': (rect?.x ?? 0) > 0,
          'boundary-top': (rect?.y ?? 0) > 0,
          'emblem-reserve':
            rect &&
            rect.x + rect.width > this.layout().emblem.x &&
            rect.y + rect.height > this.layout().emblem.y,
        }),
      };
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
          return surface && !surface.hidden
            ? [{ ...surface, element: panel.nativeElement }]
            : [];
        }),
        this.resizing() ||
          this.reducedMotion() ||
          (this.document.defaultView?.matchMedia?.(
            '(prefers-reduced-motion: reduce)',
          ).matches ??
            false),
      );
      const reduced =
        this.resizing() ||
        this.reducedMotion() ||
        (this.document.defaultView?.matchMedia?.(
          '(prefers-reduced-motion: reduce)',
        ).matches ??
          false);
      this.host.nativeElement.dispatchEvent(
        new CustomEvent('stellar-stage-layout', {
          bubbles: true,
          detail: { duration: reduced ? 0 : 420 },
        }),
      );
    });
    afterRenderEffect(() => {
      const requested = this.focusRequest();
      if (!requested || this.loading() || this.composing()) return;
      const panel = this.panels().find(
        (entry) =>
          !entry.nativeElement.classList.contains('pane-leave') &&
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
      if (this.resizeFrame)
        this.document.defaultView?.cancelAnimationFrame(this.resizeFrame);
      this.contentInjectors.clear();
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

  control(
    action: 'focus' | 'minimize' | 'restore' | 'maximize' | 'close',
    instanceId: string,
  ) {
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

  inspectContent(instanceId: string) {
    const pane = this.instances().find((p) => p.instanceId === instanceId);
    if (!pane || pane.surface === 'activity-summary') return null;
    const payload = JSON.stringify(pane.payload);
    if (new TextEncoder().encode(payload).length > 65536) return null;
    return {
      instanceId,
      surface: pane.surface,
      revision: pane.revision,
      payload,
    };
  }

  nextCommandId(): number | null {
    return this.registry.nextCommandId();
  }

  inspectPresentations() {
    return Object.freeze(
      this.instances().map((instance) =>
        Object.freeze({
          instanceId: instance.instanceId,
          surface: instance.surface,
          prominence: instance.prominence,
          minimized: instance.minimized,
          revision: instance.revision,
          selected: this.layoutState().focusedId === instance.instanceId,
          maximized: this.layoutState().maximizedId === instance.instanceId,
          title:
            typeof (instance.payload as Record<string, unknown>)?.['title'] ===
            'string'
              ? [
                  ...String(
                    (instance.payload as Record<string, unknown>)['title'],
                  ),
                ]
                  .slice(0, 240)
                  .join('')
              : this.catalogue[instance.surface].title,
          position: this.instances().findIndex(
            (p) => p.instanceId === instance.instanceId,
          ),
          rect:
            this.layout().surfaces.find(
              (p) => p.instanceId === instance.instanceId,
            ) ?? null,
          viewport: this.viewport(),
        }),
      ),
    );
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

  restoreLayout() {
    const commandId = this.nextCommandId();
    if (commandId !== null)
      this.dispatch({
        contractVersion: 1,
        commandId,
        action: 'restore-layout',
      });
  }

  movePane(instanceId: string, direction: number) {
    const ids = this.instances().map((p) => p.instanceId),
      index = ids.indexOf(instanceId);
    const other = index + direction;
    if (index < 0 || other < 0 || other >= ids.length) return;
    const commandId = this.nextCommandId();
    if (commandId !== null)
      this.dispatch({
        contractVersion: 1,
        commandId,
        action: 'swap',
        instanceId,
        otherId: ids[other],
      });
  }

  select(instanceId: string) {
    if (this.layoutState().focusedId !== instanceId) {
      this.registry.interact('focus', instanceId);
      this.layoutState.set(this.registry.layout());
    }
  }

  beginResize(event: PointerEvent, divider: StageDivider) {
    if (!(event.currentTarget instanceof HTMLElement)) return;
    event.preventDefault();
    this.registry.rememberLayout();
    this.normalizeWeights();
    this.motion.capture([]);
    this.resizing.set(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    this.drag = {
      divider,
      pointerId: event.pointerId,
      element: event.currentTarget,
    };
  }

  moveResize(event: PointerEvent) {
    if (!this.drag || event.pointerId !== this.drag.pointerId) return;
    const d = this.drag.divider;
    const box = this.host.nativeElement.getBoundingClientRect();
    const offset =
      d.axis === 'x'
        ? event.clientX - box.left - d.bounds.x
        : event.clientY - box.top - d.bounds.y;
    const size = d.axis === 'x' ? d.bounds.width : d.bounds.height;
    this.resizeRatio = Math.max(
      d.minimum,
      Math.min(1 - d.minimum, offset / Math.max(1, size)),
    );
    if (!this.resizeFrame)
      this.resizeFrame =
        this.document.defaultView?.requestAnimationFrame(() => {
          this.resizeFrame = 0;
          this.flushResize();
        }) ?? 0;
  }

  endResize() {
    this.flushResize();
    this.drag = null;
    this.resizing.set(false);
  }

  private flushResize() {
    if (this.drag && this.resizeRatio !== null) {
      this.registry.resizeGroup(
        this.drag.divider.first,
        this.drag.divider.second,
        this.resizeRatio,
      );
      this.layoutState.set(this.registry.layout());
      this.resizeRatio = null;
    }
  }

  keyResize(event: KeyboardEvent, divider: StageDivider) {
    if (
      ![
        'ArrowLeft',
        'ArrowRight',
        'ArrowUp',
        'ArrowDown',
        'Home',
        'End',
      ].includes(event.key)
    )
      return;
    event.preventDefault();
    this.registry.rememberLayout();
    this.normalizeWeights();
    const ratio =
      event.key === 'Home'
        ? divider.minimum
        : event.key === 'End'
          ? 1 - divider.minimum
          : divider.ratio +
            (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -0.03 : 0.03);
    this.registry.resizeGroup(
      divider.first,
      divider.second,
      Math.max(divider.minimum, Math.min(1 - divider.minimum, ratio)),
    );
    this.layoutState.set(this.registry.layout());
  }

  private normalizeWeights() {
    const area = Math.max(1, this.viewport().width * this.viewport().height);
    this.registry.setLayoutWeights(
      Object.fromEntries(
        this.layout().surfaces.map((p) => [
          p.instanceId,
          (p.width * p.height) / area,
        ]),
      ),
    );
  }

  private afterAction(result: StageResult) {
    if (result.status !== 'applied') return;
    const { instanceId, action } = result;
    if (action === 'arrange' || action === 'swap') {
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
    this.layoutState.set(this.registry.layout());
    for (const id of this.contentInjectors.keys())
      if (!this.instances().some((p) => p.instanceId === id))
        this.contentInjectors.delete(id);
    this.retainedPresentations.emit(this.registry.snapshot().length > 0);
    this.presentationChange.emit(
      this.registry.snapshot().some((instance) => !instance.minimized),
    );
    if (
      instanceId &&
      (action === 'open' || action === 'focus' || action === 'restore')
    )
      this.focusRequest.set({ instanceId });
  }
}
