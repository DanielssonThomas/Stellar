import { Component, computed, input } from '@angular/core';
import clsx from 'clsx';

export type SkeletonShape = 'text' | 'control';

@Component({
  selector: 'stellar-skeleton-atom',
  standalone: true,
  template: '<span [class]="classes()" aria-hidden="true"></span>',
})
export class SkeletonAtom {
  readonly shape = input<SkeletonShape>('text');
  readonly classes = computed(() =>
    clsx('inline-block animate-pulse rounded-stellar bg-stellar-skeleton', {
      'h-4 w-24': this.shape() === 'text',
      'h-5 w-20': this.shape() === 'control',
    }),
  );
}
