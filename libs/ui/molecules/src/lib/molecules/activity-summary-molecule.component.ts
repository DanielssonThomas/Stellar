import { Component, computed, input } from '@angular/core';
import { SkeletonAtom } from '@stellar/ui-atoms';
import clsx from 'clsx';
import type { ActivitySummaryPayload } from './activity-summary-model';

@Component({
  selector: 'stellar-activity-summary-molecule',
  standalone: true,
  imports: [SkeletonAtom],
  templateUrl: './activity-summary-molecule.component.html',
  styleUrl: './activity-summary-molecule.component.css',
  host: { '[attr.aria-busy]': 'loading()' },
})
export class ActivitySummaryMolecule {
  readonly payload = input<ActivitySummaryPayload | null>(null);
  readonly loading = input(false);
  readonly error = input<string | null>(null);
  readonly duration = computed(() => {
    const seconds = Math.floor(
      Math.max(0, this.payload()?.durationMs ?? 0) / 1000,
    );
    return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
  });
  readonly peak = computed(() =>
    Math.round(Math.min(1, Math.max(0, this.payload()?.peakLevel ?? 0)) * 100),
  );
  readonly classes = computed(() =>
    clsx('space-y-4 text-stellar-foreground', { 'opacity-70': this.loading() }),
  );
}
