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
import type {
  IvyQuestion,
  IvyQuestionAction,
} from '@stellar/desktop-contracts';

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
  readonly question = input<IvyQuestion | null>(null);
  readonly loading = input(false);
  readonly reducedMotion = input(false);
  readonly shown = output<string>();
  readonly answer = output<IvyQuestionAction>();
  readonly draft = signal('');
  readonly selected = signal<readonly number[]>([]);
  readonly submitted = signal(false);
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
      const question = this.question();
      const dialog = this.dialog().nativeElement;
      if (!question || !this.visible()) return;
      if (!dialog.open) dialog.showModal();
      if (question.shown && this.document.activeElement === dialog)
        dialog
          .querySelector<HTMLElement>(
            'button:not(:disabled), textarea:not(:disabled)',
          )
          ?.focus();
      if (
        !this.loading() &&
        dialog.getClientRects().length &&
        this.acknowledged !== question.id
      ) {
        this.acknowledged = question.id;
        this.shown.emit(question.id);
      }
    });
  }

  disabled() {
    return (
      this.loading() ||
      !this.question()?.shown ||
      this.question()?.answering ||
      this.submitted()
    );
  }

  choose(index: number) {
    if (this.disabled()) return;
    const question = this.question();
    if (!question || !question.choices[index]) return;
    if (question.multi_select) {
      this.selected.update((rows) =>
        rows.includes(index)
          ? rows.filter((row) => row !== index)
          : [...rows, index],
      );
    } else this.respond({ kind: 'answer', answer: question.choices[index] });
  }

  edit(event: Event) {
    if (event.target instanceof HTMLTextAreaElement)
      this.draft.set(event.target.value);
  }

  submit(event: Event) {
    event.preventDefault();
    const question = this.question();
    const typed = this.draft().trim();
    const selected = this.selected()
      .map((index) => question?.choices[index])
      .filter((choice): choice is string => Boolean(choice));
    const answer = typed || (selected.length ? JSON.stringify(selected) : '');
    if (answer && new TextEncoder().encode(answer).length <= 16384)
      this.respond({ kind: 'answer', answer });
  }

  respond(action: IvyQuestionAction) {
    if (this.disabled()) return;
    this.submitted.set(true);
    this.answer.emit(action);
  }

  cancel(event: Event) {
    event.preventDefault();
    this.respond({ kind: 'cancel' });
  }
}
