import {
  afterRenderEffect,
  Component,
  DestroyRef,
  DOCUMENT,
  ElementRef,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { SkeletonAtom } from '@stellar/ui-atoms';

@Component({
  selector: 'stellar-ivy-question-molecule',
  standalone: true,
  imports: [SkeletonAtom],
  templateUrl: './ivy-question-molecule.component.html',
  styleUrl: './ivy-question-molecule.component.css',
  host: {
    '[attr.aria-busy]': 'loading()',
    '[class.motion-reduced]': 'reducedMotion()',
  },
})
export class IvyQuestionMolecule {
  readonly promptId = input('');
  readonly text = input('');
  readonly choices = input<readonly string[]>([]);
  readonly multiSelect = input(false);
  readonly ready = input(false);
  readonly answering = input(false);
  readonly loading = input(false);
  readonly reducedMotion = input(false);
  readonly shown = output<string>();
  readonly answer = output<string>();
  readonly skipped = output<void>();
  readonly cancelled = output<void>();
  readonly draft = signal('');
  readonly selected = signal<readonly number[]>([]);
  readonly submitted = signal(false);
  readonly error = signal('');
  private readonly dialog =
    viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly document = inject(DOCUMENT);
  private readonly visible = signal(
    this.document.visibilityState === 'visible',
  );
  private acknowledged?: string;

  constructor() {
    const visibility = () =>
      this.visible.set(this.document.visibilityState === 'visible');
    this.document.addEventListener('visibilitychange', visibility);
    inject(DestroyRef).onDestroy(() =>
      this.document.removeEventListener('visibilitychange', visibility),
    );
    afterRenderEffect(() => {
      const id = this.promptId();
      const dialog = this.dialog().nativeElement;
      if (!id || !this.visible()) return;
      if (!dialog.open) dialog.showModal();
      if (this.ready() && this.document.activeElement === dialog)
        dialog
          .querySelector<HTMLElement>(
            'button:not(:disabled), textarea:not(:disabled)',
          )
          ?.focus();
      if (
        !this.loading() &&
        dialog.getClientRects().length &&
        this.acknowledged !== id
      ) {
        this.acknowledged = id;
        this.shown.emit(id);
      }
    });
  }

  disabled() {
    return (
      this.loading() || !this.ready() || this.answering() || this.submitted()
    );
  }

  choose(index: number) {
    if (this.disabled()) return;
    this.error.set('');
    const choice = this.choices()[index];
    if (!choice) return;
    if (this.multiSelect()) {
      this.selected.update((rows) =>
        rows.includes(index)
          ? rows.filter((row) => row !== index)
          : [...rows, index],
      );
    } else this.respond(choice);
  }

  edit(event: Event) {
    this.error.set('');
    if (event.target instanceof HTMLTextAreaElement)
      this.draft.set(event.target.value);
  }

  submit(event: Event) {
    event.preventDefault();
    const typed = this.draft().trim();
    const selected = this.selected()
      .map((index) => this.choices()[index])
      .filter((choice): choice is string => Boolean(choice));
    const answer = typed || (selected.length ? JSON.stringify(selected) : '');
    if (new TextEncoder().encode(answer).length > 16384) {
      this.error.set('Please shorten your answer or choose fewer options.');
      return;
    }
    if (answer) this.respond(answer);
  }

  respond(answer: string) {
    if (this.disabled()) return;
    this.submitted.set(true);
    this.answer.emit(answer);
  }

  skip() {
    if (this.disabled()) return;
    this.submitted.set(true);
    this.skipped.emit();
  }

  cancel(event?: Event) {
    event?.preventDefault();
    if (this.disabled()) return;
    this.submitted.set(true);
    this.cancelled.emit();
  }
}
