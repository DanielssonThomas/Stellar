import {
  afterRenderEffect,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  Injector,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { SkeletonAtom } from '@stellar/ui-atoms';
import clsx from 'clsx';

export type PromptComposerStatus =
  | 'idle'
  | 'composing'
  | 'refining'
  | 'finalizing'
  | 'submitting'
  | 'error';

export interface ComposerFinalizedText {
  readonly raw: string;
  readonly refined: string;
}

@Component({
  selector: 'stellar-prompt-composer-molecule',
  standalone: true,
  imports: [SkeletonAtom],
  templateUrl: './prompt-composer-molecule.component.html',
  styleUrl: './prompt-composer-molecule.component.css',
  host: { '[attr.aria-busy]': 'loading()' },
})
export class PromptComposerMolecule {
  readonly raw = input('');
  readonly refined = input<string | null>(null);
  readonly status = input<PromptComposerStatus>('idle');
  readonly visible = input(false);
  readonly reducedMotion = input(false);
  readonly loading = input(false);
  private readonly injector = inject(Injector);
  private readonly group = viewChild<ElementRef<HTMLElement>>('group');
  private readonly rawText = viewChild<ElementRef<HTMLElement>>('rawText');
  private readonly refinedText =
    viewChild<ElementRef<HTMLElement>>('refinedText');
  private readonly refinedReady = signal(false);
  private readonly dissolved = signal(false);
  private pending?: AbortController;
  private destroyed = false;
  readonly showRefined = computed(
    () =>
      this.refinedReady() ||
      (this.status() === 'error' && this.refined() !== null),
  );
  readonly classes = computed(() =>
    clsx('composer text-stellar-foreground', {
      'refined-ready': this.showRefined(),
      dissolved: this.dissolved(),
    }),
  );

  constructor() {
    afterRenderEffect(() => {
      if (this.status() === 'composing' || this.status() === 'idle') {
        this.refinedReady.set(false);
        this.dissolved.set(false);
      } else if (this.status() === 'error') this.dissolved.set(false);
    });
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      this.pending?.abort();
    });
  }

  async presentFinalized(
    text: ComposerFinalizedText,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.destroyed || signal.aborted) throw this.cancelled();
    this.pending?.abort();
    const controller = new AbortController();
    this.pending = controller;
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    const animations: Animation[] = [];
    try {
      await this.rendered(
        controller.signal,
        () =>
          this.visible() &&
          !this.loading() &&
          this.status() === 'finalizing' &&
          this.raw() === text.raw &&
          this.refined() === text.refined &&
          Boolean(this.group() && this.rawText() && this.refinedText()),
      );
      this.requireCurrent(controller);
      const group = this.group()?.nativeElement;
      const raw = this.rawText()?.nativeElement;
      const refined = this.refinedText()?.nativeElement;
      if (!group?.isConnected || !raw || !refined) throw this.cancelled();
      const reduced =
        this.reducedMotion() ||
        group.ownerDocument.defaultView?.matchMedia?.(
          '(prefers-reduced-motion: reduce)',
        ).matches;
      if (!reduced && typeof group.animate === 'function') {
        const transition = [
          raw.animate([{ opacity: 1 }, { opacity: 0 }], {
            duration: 220,
            fill: 'forwards',
            easing: 'ease-out',
          }),
          refined.animate([{ opacity: 0 }, { opacity: 1 }], {
            duration: 220,
            fill: 'forwards',
            easing: 'ease-out',
          }),
        ];
        animations.push(...transition);
        await this.finished(transition, controller.signal);
      }
      this.refinedReady.set(true);
      await this.rendered(controller.signal, () => this.showRefined());
      this.requireCurrent(controller);
      if (!reduced && typeof group.animate === 'function') {
        const dissolve = group.animate([{ opacity: 1 }, { opacity: 0 }], {
          duration: 240,
          fill: 'forwards',
          easing: 'ease-in',
        });
        animations.push(dissolve);
        await this.finished([dissolve], controller.signal);
      }
      this.dissolved.set(true);
      await this.rendered(controller.signal, () => this.dissolved());
      this.requireCurrent(controller);
    } finally {
      for (const animation of animations) animation.cancel();
      signal.removeEventListener('abort', abort);
      if (this.pending === controller) this.pending = undefined;
    }
  }

  private rendered(signal: AbortSignal, ready: () => boolean): Promise<void> {
    if (signal.aborted || this.destroyed)
      return Promise.reject(this.cancelled());
    return new Promise<void>((resolve, reject) => {
      const abort = () => {
        watcher.destroy();
        reject(this.cancelled());
      };
      const watcher = afterRenderEffect(
        () => {
          if (!ready()) return;
          watcher.destroy();
          signal.removeEventListener('abort', abort);
          resolve();
        },
        { injector: this.injector },
      );
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  private async finished(
    animations: readonly Animation[],
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) throw this.cancelled();
    let abort: (() => void) | undefined;
    try {
      await Promise.race([
        Promise.all(animations.map((animation) => animation.finished)),
        new Promise<never>((_, reject) => {
          abort = () => reject(this.cancelled());
          signal.addEventListener('abort', abort, { once: true });
        }),
      ]);
      if (signal.aborted) throw this.cancelled();
    } finally {
      if (abort) signal.removeEventListener('abort', abort);
    }
  }

  private cancelled() {
    return new DOMException('Prompt presentation cancelled', 'AbortError');
  }
  private requireCurrent(controller: AbortController) {
    if (
      controller.signal.aborted ||
      this.destroyed ||
      this.pending !== controller
    )
      throw this.cancelled();
  }
}
