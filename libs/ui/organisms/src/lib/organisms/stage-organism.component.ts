import { NgComponentOutlet } from '@angular/common';
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
} from '@angular/core';
import type { InteractionEvent } from '@stellar/desktop-interaction';
import { SkeletonAtom } from '@stellar/ui-atoms';
import clsx from 'clsx';
import { STAGE_CATALOGUE } from './stage-catalogue';
import { StageResult } from './stage-contract';
import { directStage } from './stage-director';
import { createStageRegistry } from './stage-registry';

@Component({
  selector: 'stellar-stage-organism',
  standalone: true,
  imports: [SkeletonAtom, NgComponentOutlet],
  templateUrl: './stage-organism.component.html',
  styleUrl: './stage-organism.component.css',
  host: {
    '[attr.aria-busy]': 'loading()',
    '(keydown.escape)': 'escape($event)',
  },
})
export class StageOrganism {
  readonly loading = input(false);
  readonly interaction = output<InteractionEvent>();
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
  private readonly origins = new Map<string, HTMLElement>();
  private readonly focusRequest = signal<string | null>(null);
  private readonly viewport = signal({ width: 0, height: 0 });
  private readonly instances = signal(this.registry.snapshot());
  readonly layout = computed(() =>
    directStage(this.viewport(), this.instances()),
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
          classes: clsx(
            'surface rounded-stellar bg-stellar-canvas text-stellar-foreground shadow-stellar-card',
            { 'primary-surface': instance.prominence === 'primary' },
          ),
        },
      ];
    }),
  );

  constructor() {
    let observer: ResizeObserver | undefined;
    const measure = () => {
      const bounds = this.host.nativeElement.getBoundingClientRect();
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
      const requested = this.focusRequest();
      if (!requested || this.loading()) return;
      const panel = this.panels().find(
        (entry) => entry.nativeElement.dataset['instanceId'] === requested,
      );
      if (panel) {
        panel.nativeElement.focus();
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
      this.registry.dispose();
    });
  }

  dispatch(command: unknown): StageResult {
    const origin = this.document.activeElement;
    const result = this.registry.dispatch(command);
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
    this.afterAction(this.registry.interact(action, instanceId));
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
    if (result.status !== 'applied' || !result.instanceId) return;
    const { instanceId, action } = result;
    if (action === 'close' || action === 'minimize') {
      const panel = this.panels().find(
        (entry) => entry.nativeElement.dataset['instanceId'] === instanceId,
      )?.nativeElement;
      const origin = this.origins.get(instanceId);
      if (panel && origin?.isConnected && !panel.contains(origin)) {
        for (const [dependent, savedOrigin] of this.origins) {
          if (panel.contains(savedOrigin)) this.origins.set(dependent, origin);
        }
      }
      if (panel?.contains(this.document.activeElement) && origin?.isConnected)
        origin.focus();
      if (action === 'close') {
        this.origins.delete(instanceId);
        this.interaction.emit({ type: 'dismiss' });
      }
    }
    this.instances.set(this.registry.snapshot());
    if (action === 'open' || action === 'focus')
      this.focusRequest.set(instanceId);
  }
}
