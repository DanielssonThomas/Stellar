import {
  afterEveryRender,
  Component,
  computed,
  ElementRef,
  input,
  output,
  viewChild,
} from '@angular/core';
import { SkeletonAtom } from './skeleton-atom.component';
import clsx from 'clsx';

@Component({
  selector: 'stellar-toggle-switch-atom',
  standalone: true,
  imports: [SkeletonAtom],
  templateUrl: './toggle-switch-atom.component.html',
  styleUrl: './toggle-switch-atom.component.css',
  host: { '[attr.aria-busy]': 'loading()' },
})
export class ToggleSwitchAtom {
  private readonly control =
    viewChild.required<ElementRef<HTMLInputElement>>('control');
  readonly label = input('Setting');
  readonly description = input('');
  readonly checked = input(false);
  readonly disabled = input(false);
  readonly reducedMotion = input(false);
  readonly loading = input(false);
  readonly checkedChange = output<boolean>();
  readonly classes = computed(() =>
    clsx('switch-row', {
      'switch-on': this.checked(),
      'switch-disabled': this.disabled() || this.loading(),
      'motion-reduced': this.reducedMotion(),
    }),
  );

  constructor() {
    // Keep the native state truthful when an asynchronous owner rejects a change.
    afterEveryRender(() => {
      this.control().nativeElement.checked = this.checked();
    });
  }

  change(event: Event) {
    if (!(event.target instanceof HTMLInputElement)) return;
    const checked = event.target.checked;
    if (this.disabled() || this.loading())
      event.target.checked = this.checked();
    else this.checkedChange.emit(checked);
  }
}
