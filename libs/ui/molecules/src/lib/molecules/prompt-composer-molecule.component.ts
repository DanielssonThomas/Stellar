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
import { fitPromptText, promptTextEdit } from './prompt-composer-text';

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
  readonly draft = input<string | null>(null);
  readonly preview = input('');
  readonly refinementRevision = input(0);
  readonly refined = input<string | null>(null);
  readonly status = input<PromptComposerStatus>('idle');
  readonly visible = input(false);
  readonly reducedMotion = input(false);
  readonly loading = input(false);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly group = viewChild<ElementRef<HTMLElement>>('group');
  private readonly opened = signal(false);
  private readonly dissolved = signal(false);
  private readonly edited = signal<string | null>(null);
  readonly draftEditing = signal(false);
  private draftTarget?: string;
  private draftRevision = 0;
  private draftEdit?: AbortController;
  private entrance?: {
    group: HTMLElement;
    controller: AbortController;
    completion: Promise<void>;
  };
  private pending?: AbortController;
  private destroyed = false;
  readonly displayText = computed(() => {
    const base =
      this.status() === 'error'
        ? (this.refined() ?? this.draft() ?? this.raw())
        : (this.edited() ?? this.draft() ?? this.raw());
    const preview = this.status() === 'composing' ? this.preview() : '';
    return preview
      ? `${base}${base && !/\s$/.test(base) ? ' ' : ''}${preview}`
      : base;
  });
  readonly classes = computed(() =>
    clsx('composer text-stellar-foreground', {
      opened: this.opened(),
      dissolved: this.dissolved(),
    }),
  );

  constructor() {
    let observer: ResizeObserver | undefined;
    afterRenderEffect(() => {
      const group = this.group()?.nativeElement;
      const visible = this.visible() && !this.loading();
      const raw = this.raw(),
        refined = this.refined(),
        status = this.status();
      const draft = this.draft() ?? raw;
      const revision = this.refinementRevision();
      const displayed = this.displayText();
      if (status === 'composing') {
        this.syncDraft(draft, revision);
        this.dissolved.set(false);
      } else if (status === 'idle') {
        this.edited.set(null);
        this.dissolved.set(false);
      } else if (status === 'error') this.dissolved.set(false);
      if (status !== 'composing') this.cancelDraftEdit();
      if (!visible || !group) {
        this.cancelDraftEdit();
        this.draftTarget = undefined;
        this.draftRevision = 0;
        this.entrance?.controller.abort();
        this.pending?.abort();
        this.entrance = undefined;
        this.opened.set(false);
        observer?.disconnect();
        observer = undefined;
        return;
      }
      fitPromptText(group, this.host.nativeElement, [
        raw,
        refined ?? raw,
        draft,
        displayed,
      ]);
      if (this.reduced(group)) {
        for (const animation of group.getAnimations?.({ subtree: true }) ?? [])
          animation.finish();
      }
      if (this.entrance?.group === group) return;
      this.entrance?.controller.abort();
      observer?.disconnect();
      this.opened.set(false);
      const controller = new AbortController();
      const entrance = { group, controller, completion: Promise.resolve() };
      this.entrance = entrance;
      entrance.completion = this.enter(group, controller.signal);
      void entrance.completion.catch(() => undefined);
      if (typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver(() =>
          fitPromptText(group, this.host.nativeElement, [
            this.raw(),
            this.refined() ?? this.raw(),
            this.draft() ?? this.raw(),
            this.displayText(),
          ]),
        );
        observer.observe(this.host.nativeElement);
      }
    });
    const fonts = this.host.nativeElement.ownerDocument.fonts;
    const refit = () => {
      const group = this.group()?.nativeElement;
      if (group)
        fitPromptText(group, this.host.nativeElement, [
          this.raw(),
          this.refined() ?? this.raw(),
          this.draft() ?? this.raw(),
          this.displayText(),
        ]);
    };
    fonts?.addEventListener('loadingdone', refit);
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      this.cancelDraftEdit();
      this.pending?.abort();
      this.entrance?.controller.abort();
      observer?.disconnect();
      fonts?.removeEventListener('loadingdone', refit);
    });
  }

  async presentFinalized(
    text: ComposerFinalizedText,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.destroyed || signal.aborted) throw this.cancelled();
    this.cancelDraftEdit();
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
          this.opened(),
      );
      const group = this.requireCurrent(controller, text);
      await this.editText(
        {
          raw: this.edited() ?? this.draft() ?? text.raw,
          refined: text.refined,
        },
        controller.signal,
        this.reduced(group),
      );
      this.requireCurrent(controller, text);
      await this.rendered(
        controller.signal,
        () => this.displayText() === text.refined,
      );
      this.requireCurrent(controller, text);
      await this.holdCorrected(group, controller.signal);
      this.requireCurrent(controller, text);
      if (!this.reduced(group)) {
        animations.push(...this.brackets(group, false));
        await this.finished(animations, controller.signal);
      }
      this.requireCurrent(controller, text);
      this.dissolved.set(true);
      await this.rendered(controller.signal, () => this.dissolved());
      this.requireCurrent(controller, text);
    } finally {
      for (const animation of animations) animation.cancel();
      signal.removeEventListener('abort', abort);
      if (this.pending === controller) this.pending = undefined;
    }
  }

  private syncDraft(target: string, revision: number) {
    const previous = this.edited() ?? this.draftTarget ?? target;
    const changed = target !== this.draftTarget;
    const refined =
      this.draftTarget !== undefined && revision > this.draftRevision;
    this.draftTarget = target;
    this.draftRevision = revision;
    if (!changed) return;
    this.cancelDraftEdit();
    if (!refined) {
      this.edited.set(target);
      return;
    }
    const controller = new AbortController();
    this.draftEdit = controller;
    this.draftEditing.set(true);
    void (async () => {
      await this.entrance?.completion;
      if (
        controller.signal.aborted ||
        this.status() !== 'composing' ||
        this.draftTarget !== target
      )
        throw this.cancelled();
      const group = this.group()?.nativeElement;
      if (!group || !this.visible()) throw this.cancelled();
      await this.editText(
        { raw: previous, refined: target },
        controller.signal,
        this.reduced(group),
      );
    })()
      .catch(() => {
        if (!controller.signal.aborted && this.draftTarget === target)
          this.edited.set(target);
      })
      .finally(() => {
        if (this.draftEdit === controller) {
          this.draftEdit = undefined;
          this.draftEditing.set(false);
        }
      });
  }

  private cancelDraftEdit() {
    this.draftEdit?.abort();
    this.draftEdit = undefined;
    this.draftEditing.set(false);
  }

  private holdCorrected(
    group: HTMLElement,
    signal: AbortSignal,
  ): Promise<void> {
    const view = group.ownerDocument.defaultView;
    if (this.reduced(group) || !view?.requestAnimationFrame)
      return Promise.resolve();
    return new Promise((resolve, reject) => {
      let frame = 0;
      let started: number | undefined;
      const abort = () => {
        view.cancelAnimationFrame(frame);
        signal.removeEventListener('abort', abort);
        reject(this.cancelled());
      };
      const tick = (now: number) => {
        if (signal.aborted) return abort();
        started ??= now;
        if (this.reduced(group) || now - started >= 1000) {
          signal.removeEventListener('abort', abort);
          resolve();
        } else frame = view.requestAnimationFrame(tick);
      };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      else frame = view.requestAnimationFrame(tick);
    });
  }

  private async enter(group: HTMLElement, signal: AbortSignal) {
    const animations = this.reduced(group) ? [] : this.brackets(group, true);
    try {
      await this.finished(animations, signal);
      if (signal.aborted || !this.visible() || !group.isConnected)
        throw this.cancelled();
      this.opened.set(true);
      await this.rendered(signal, () => this.opened());
    } finally {
      for (const animation of animations) animation.cancel();
    }
  }

  private brackets(group: HTMLElement, opening: boolean): Animation[] {
    if (typeof group.animate !== 'function') return [];
    const elements = [
      '.left-brace',
      '.right-brace',
      '.background-tone',
      '.text-stack',
    ].map((selector) => group.querySelector<HTMLElement>(selector));
    const frames: Keyframe[][] = [
      [
        { left: 'calc(50% - 0.75rem)', opacity: 0 },
        { left: '0px', opacity: 1 },
      ],
      [
        { right: 'calc(50% - 0.75rem)', opacity: 0 },
        { right: '0px', opacity: 1 },
      ],
      [
        { transform: 'scaleX(0)', opacity: 0 },
        { transform: 'scaleX(1)', opacity: 1 },
      ],
      [
        { opacity: 0, clipPath: 'inset(0 50%)' },
        { opacity: 1, clipPath: 'inset(0 0%)' },
      ],
    ];
    return elements.flatMap((element, index) =>
      element
        ? [
            element.animate(
              opening ? frames[index] : [...frames[index]].reverse(),
              {
                duration: 1000,
                fill: 'forwards',
                easing: 'cubic-bezier(0.4, 0, 0.6, 1)',
              },
            ),
          ]
        : [],
    );
  }

  private editText(
    text: ComposerFinalizedText,
    signal: AbortSignal,
    reduced: boolean,
  ): Promise<void> {
    const edit = promptTextEdit(text.raw, text.refined);
    const view = this.host.nativeElement.ownerDocument.defaultView;
    if (reduced || !edit.steps || !view?.requestAnimationFrame) {
      this.edited.set(text.refined);
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      let frame = 0,
        started: number | undefined;
      const abort = () => {
        view.cancelAnimationFrame(frame);
        signal.removeEventListener('abort', abort);
        reject(this.cancelled());
      };
      const duration = 1000;
      const tick = (now: number) => {
        if (signal.aborted) {
          abort();
          return;
        }
        started ??= now;
        const step = Math.min(
          edit.steps,
          Math.floor(((now - started) / duration) * edit.steps),
        );
        const group = this.group()?.nativeElement;
        const currentStep = group && this.reduced(group) ? edit.steps : step;
        this.edited.set(edit.at(currentStep));
        if (currentStep === edit.steps) {
          signal.removeEventListener('abort', abort);
          resolve();
        } else frame = view.requestAnimationFrame(tick);
      };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      else frame = view.requestAnimationFrame(tick);
    });
  }

  private reduced(group: HTMLElement) {
    return (
      this.reducedMotion() ||
      Boolean(
        group.ownerDocument.defaultView?.matchMedia?.(
          '(prefers-reduced-motion: reduce)',
        ).matches,
      )
    );
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
  private requireCurrent(
    controller: AbortController,
    text: ComposerFinalizedText,
  ): HTMLElement {
    const group = this.group()?.nativeElement;
    const bounds = group?.getBoundingClientRect();
    if (
      controller.signal.aborted ||
      this.destroyed ||
      this.pending !== controller ||
      !this.visible() ||
      this.loading() ||
      this.status() !== 'finalizing' ||
      this.raw() !== text.raw ||
      this.refined() !== text.refined ||
      !group?.isConnected ||
      !bounds ||
      bounds.width <= 0 ||
      bounds.height <= 0 ||
      group.dataset['textFits'] === 'false'
    )
      throw this.cancelled();
    return group;
  }
}
