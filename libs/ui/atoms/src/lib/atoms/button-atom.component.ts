import { Component, computed, input, output } from '@angular/core';
import clsx from 'clsx';
import { SkeletonAtom } from './skeleton-atom.component';

@Component({
  selector: 'stellar-button-atom',
  standalone: true,
  imports: [SkeletonAtom],
  template: `
    <button
      type="button"
      [class]="classes()"
      [disabled]="disabled() || loading()"
      [attr.aria-busy]="loading()"
      [attr.aria-label]="label()"
      (click)="activated.emit()"
    >
      @if (loading()) {
        <stellar-skeleton-atom shape="control" />
      } @else {
        {{ label() }}
      }
    </button>
  `,
})
export class ButtonAtom {
  readonly label = input.required<string>();
  readonly loading = input(false);
  readonly disabled = input(false);
  readonly activated = output<void>();

  readonly classes = computed(() =>
    clsx(
      'inline-flex min-h-11 min-w-28 items-center justify-center rounded-stellar px-4 py-2 font-medium text-white transition-colors',
      'bg-stellar-primary hover:bg-stellar-primary-hover',
      {
        'cursor-wait opacity-70': this.loading(),
        'opacity-50': this.disabled(),
      },
    ),
  );
}
